/**
 * 桌面端「补歌词」胶水（t5）：渲染进程一侧的桥接与自动重扫。
 *
 * 链路：主进程跑外部工具（spawn powershell，desktop/lyricsTool.js）→
 * 状态推到渲染进程（preload 暴露的 `window.qingyinDesktop.lyrics.onStatus`）→
 * **done 时自动调 store 的 `rescanLyrics()`**（认领工具写出的 .lrc）。
 *
 * 为什么这段必须在渲染进程（不能放主进程）：
 *  - `rescanLyrics()` 是渲染进程的 Zustand action，曲库句柄 / IndexedDB /
 *    `<audio>` 全在渲染进程；主进程够不到。
 *  - 主进程侧唯一出路 `webContents.reload()` 会销毁渲染进程 = **音乐停**，
 *    而工具跑完那一刻恰恰最可能正在放歌（违背「关窗继续放歌」的第一目标）。
 *  - 隐藏窗口照样收 webContents 推送，音乐不停——这正是本模块存在的意义。
 *
 * 为什么不复用 selftest 钩子：`__qingyinTest` 只在 `?selftest=1` 存在，是
 * 测试夹具不是产品通道；夹具曲库是内存 File，rescan 扫不到磁盘文件。
 *
 * 对 web 构建的影响：**零**。桥不存在时 `init()` 在注册任何监听之前就
 * return；类型用本地窄断言而非全局声明，纯浏览器里模块是死的。
 */
import { useEffect, useState } from 'react';
import { useAppStore } from './store.js';

/** 主进程推过来的工具状态（与 desktop/lyricsTool.js 的快照形状一致）。 */
export interface DesktopLyricsToolStatus {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  exitCode: number | null;
  scriptLabel: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  tail: string[];
  error: string | null;
}

/** preload 暴露的桥（desktop/preload.js 的 lyrics 段）。 */
export interface DesktopLyricsBridge {
  run(): Promise<{ ok: boolean; reason?: string; status: DesktopLyricsToolStatus }>;
  status(): Promise<DesktopLyricsToolStatus>;
  cancel(): Promise<{ cancelled: boolean; status?: DesktopLyricsToolStatus }>;
  onStatus(callback: (state: DesktopLyricsToolStatus) => void): () => void;
}

/** 窄断言取桥（不用全局 declare：避免与别的桌面模块对 window 的声明互相踩）。 */
function readBridge(): DesktopLyricsBridge | undefined {
  const holder = window as { qingyinDesktop?: { lyrics?: DesktopLyricsBridge } };
  return holder.qingyinDesktop?.lyrics;
}

/** 桥在不在（决定 LyricsPanel 里那个按钮**渲染不渲染**——不存在，而非禁用）。 */
export function hasDesktopLyricsBridge(): boolean {
  return Boolean(readBridge());
}

let bridge: DesktopLyricsBridge | undefined;
let initialized = false;
let latest: DesktopLyricsToolStatus | null = null;
const listeners = new Set<(state: DesktopLyricsToolStatus | null) => void>();

function emit() {
  for (const listener of listeners) listener(latest);
}

/** 终态里只有 done 触发重扫（failed/cancelled 不扫：没扫出东西的语义）。 */
async function onStatusPushed(state: DesktopLyricsToolStatus) {
  const previous = latest?.status;
  latest = state;
  emit();
  const store = useAppStore.getState();
  if (state.status !== previous) {
    if (state.status === 'running') {
      store.pushNotice(`补歌词工具运行中（${state.scriptLabel ?? '外部工具'}）`);
    } else if (state.status === 'done') {
      // 工具成功 → 自动重扫认领 .lrc（rescanLyrics 自己会推「新认领 N」统计）
      await store.rescanLyrics();
      store.pushNotice('补歌词完成，已重新扫描歌词');
    } else if (state.status === 'cancelled') {
      // 取消是用户主动行为：中性提示，绝不带「失败」字眼（终态语义与主进程一致）
      store.pushNotice('已取消补歌词');
    } else if (state.status === 'failed') {
      const lastLine = state.tail.length > 0 ? `（${state.tail[state.tail.length - 1]}）` : '';
      store.pushNotice(`补歌词失败${state.error ?? ''}${lastLine}`, 'warn');
    }
  }
}

/**
 * 初始化：订阅主进程状态推送。幂等；桥不存在时**在注册任何监听之前**返回。
 * @param injected 测试注入的假桥（产品代码不传，从 window 读）
 */
export function initDesktopLyrics(injected?: DesktopLyricsBridge): boolean {
  if (initialized) return true;
  const actual = injected ?? readBridge();
  if (!actual) return false;
  initialized = true;
  bridge = actual;
  bridge.onStatus(onStatusPushed);
  return true;
}

/** 手动触发一次补歌词（歌词面板按钮用；托盘菜单走主进程同一个函数）。 */
export async function startFillLyrics(): Promise<void> {
  if (!bridge) return;
  const current = latest?.status;
  if (current === 'running') {
    useAppStore.getState().pushNotice('补歌词工具正在运行，稍候或先取消', 'warn');
    return;
  }
  const result = await bridge.run();
  if (!result.ok && result.reason === 'no-music-path') {
    useAppStore.getState().pushNotice('没有指定音乐文件夹，补歌词没有开始', 'warn');
  } else if (!result.ok && result.reason === 'already-running') {
    useAppStore.getState().pushNotice('补歌词工具正在运行', 'info');
  }
}

/** 取消正在跑的工具。 */
export async function cancelFillLyrics(): Promise<void> {
  if (!bridge) return;
  await bridge.cancel();
}

/** 测试专用：把模块状态复位（同一文件里多次 init 的用例需要）。 */
export function resetDesktopLyricsForTest(): void {
  initialized = false;
  bridge = undefined;
  latest = null;
  listeners.clear();
}

/**
 * 工具状态的展示文案。
 *
 * 放在这里而不是组件里：歌词面板与侧栏都要显示同一份状态，两处各写一份措辞必然漂移。
 * 语义约定：cancelled 是**中性**的（绝不带"失败"字眼），done 叫完成，
 * 只有 failed 才叫失败（带退出码，用户拿它对工具日志）。
 */
export function describeToolStatus(status: DesktopLyricsToolStatus): string {
  switch (status.status) {
    case 'running':
      return '补歌词工具运行中';
    case 'done':
      return '补歌词完成，已重新扫描';
    case 'cancelled':
      return '已取消补歌词';
    case 'failed':
      return status.exitCode !== null
        ? `补歌词失败（退出码 ${status.exitCode}）`
        : `补歌词失败${status.error ? `：${status.error}` : ''}`;
    default:
      return '';
  }
}

/** React 侧的状态视图（歌词面板与侧栏共用）。 */
export interface DesktopLyricsView {
  status: DesktopLyricsToolStatus | null;
  start: () => void;
  cancel: () => void;
}

export function useDesktopLyrics(): DesktopLyricsView {
  const [state, setState] = useState<DesktopLyricsToolStatus | null>(latest);
  useEffect(() => {
    const listener = (next: DesktopLyricsToolStatus | null) => setState(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    status: state,
    start: () => void startFillLyrics(),
    cancel: () => void cancelFillLyrics(),
  };
}
