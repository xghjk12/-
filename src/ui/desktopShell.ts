/**
 * 桌面壳（Electron）与播放器之间唯一的接缝：**托盘播放命令 + 播放状态上报**。
 *
 * 为什么需要这个文件：托盘菜单里的「播放/暂停」「上一首」「下一首」必须落到
 * `useAppStore` 的既有动作上，而 store 是模块作用域的 zustand 实例，**没有挂在
 * window 上**；preload 也够不到模块作用域。所以壳层要通过 `contextBridge` 暴露的
 * `window.qingyinDesktop` 跟页面说话，页面这边就必须有一个订阅点。
 *
 * 边界（队长批的形状，别越界）：
 *  - **只调用现有 store 动作**（`togglePlay` / `previous` / `next`），这里不写任何播放逻辑；
 *  - **不改 `store.ts`、不改 store 结构**，只在外面订阅；
 *  - 播放状态由这边**上报**给主进程（主进程不猜），且只在菜单关心的切片
 *    （playing / currentIndex / queueLength）真的变化时才发，拖音量条不会刷 IPC。
 *
 * 浏览器里（web 构建、PWA）`window.qingyinDesktop` 不存在：
 * **在订阅任何东西之前**就返回，不碰 store、不注册全局监听、不发 IPC，
 * 行为与体积都跟没这个文件一样。
 *
 * 类型上沿用 `platform/browserMusicSource.ts` 的既有约定：从 globalThis 取值再断言，
 * 不用 `declare global`（与内置声明冲突就会编译失败）。
 */
import { useAppStore } from './store.js';

/** 壳层能发过来的命令。白名单在 `desktop/constants.js`，这里对未知类型一律忽略。 */
type ShellCommand = { type: string };

/** 上报给主进程的播放状态：只放菜单要用的事实，不放整个 store。 */
type ShellStatus = {
  playing: boolean;
  currentIndex: number;
  queueLength: number;
  /** 有没有"当前曲目"——主进程用它决定三个菜单项是否禁用。 */
  hasTrack: boolean;
};

type DesktopBridge = {
  onCommand?: (callback: (command: ShellCommand) => void) => (() => void) | void;
  reportStatus?: (status: ShellStatus) => void;
};

function readBridge(): DesktopBridge | undefined {
  const bridge = (globalThis as unknown as { qingyinDesktop?: DesktopBridge }).qingyinDesktop;
  return bridge && typeof bridge === 'object' ? bridge : undefined;
}

type AppState = ReturnType<typeof useAppStore.getState>;

function statusOf(state: AppState): ShellStatus {
  const queueLength = state.queue.length;
  const currentIndex = state.currentIndex;
  return {
    playing: state.playing,
    currentIndex,
    queueLength,
    hasTrack: queueLength > 0 && currentIndex >= 0,
  };
}

function sameStatus(a: ShellStatus, b: ShellStatus): boolean {
  return (
    a.playing === b.playing &&
    a.currentIndex === b.currentIndex &&
    a.queueLength === b.queueLength &&
    a.hasTrack === b.hasTrack
  );
}

/** 模块级 guard：入口只调一次，但 HMR 会重跑入口，重复订阅会让一条命令被放两次。 */
let started = false;

/**
 * 调一个 store 动作，并把同步异常与 Promise rejection 都吞掉。
 *
 * 这是从托盘点进来的：调用方是壳层的 IPC 派发处，抛出去只会变成一个
 * "未处理的 rejection"，用户什么也看不见，还可能在日志里淹掉真正的错。
 * 播放动作失败（比如音频文件读不出来）由 store 自己的通知机制告诉用户。
 */
function runStoreAction(action: () => Promise<void> | void): void {
  try {
    const result = action();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        // 见上：这里不重抛，也不自己造提示（store 会推通知）
      });
    }
  } catch {
    // 同步抛错同理
  }
}

/**
 * 装上桌面壳的订阅。幂等；没有桥就什么都不做。
 *
 * 返回是否真的装上了（测试与排障用；生产调用方不需要看）。
 */
export function startDesktopShell(): boolean {
  if (started) return true;

  const bridge = readBridge();
  // 桥不在（浏览器 / PWA）：在订阅任何东西之前就走人，零副作用
  if (!bridge || typeof bridge.onCommand !== 'function') return false;
  started = true;

  const report = (status: ShellStatus): void => {
    if (typeof bridge.reportStatus !== 'function') return;
    try {
      bridge.reportStatus(status);
    } catch {
      // 上报失败不能拖垮播放：托盘文案顶多旧一点，歌要继续放
    }
  };

  bridge.onCommand((command) => {
    if (!command || typeof command.type !== 'string') return;
    const store = useAppStore.getState();
    if (command.type === 'play-pause') {
      runStoreAction(store.togglePlay);
    } else if (command.type === 'prev') {
      runStoreAction(store.previous);
    } else if (command.type === 'next') {
      runStoreAction(store.next);
    }
    // 未知类型忽略：命令白名单归主进程管（desktop/playbackStatus.js）
  });

  let last = statusOf(useAppStore.getState());
  // 启动即报一次：托盘菜单在第一次刷新时就是对的，不用等用户先点一下播放
  report(last);

  useAppStore.subscribe((state) => {
    const next = statusOf(state);
    if (sameStatus(next, last)) return;
    last = next;
    report(next);
  });

  return true;
}
