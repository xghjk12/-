/**
 * `src/ui/desktopShell.ts` 的单测（jsdom）。
 *
 * 这个文件是"桌面壳 ↔ 播放器"的接缝，风险全在接缝上：
 *  - 命令必须**只**落到既有 store 动作上（用 spy 断言，不真的驱动音频）；
 *  - 状态上报必须只在菜单关心的切片变化时发生（拖音量条不该刷 IPC）；
 *  - 浏览器里没有桥时必须**零副作用**（web 构建不能因为这个文件改变行为）；
 *  - 幂等：入口被重跑（HMR）不能重复订阅，否则一条「下一首」会变成跳两首。
 *
 * 每个用例都 `vi.resetModules()` 再动态 import：模块级 `started` guard 必须在
 * 用例之间是干净的，否则"幂等"这条根本测不出来（第一个用例就把它置真了）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type CommandCallback = (command: { type: string }) => void;
type ShellStatus = { playing: boolean; currentIndex: number; queueLength: number; hasTrack: boolean };

/** 装一个假的 `window.qingyinDesktop`，并把命令入口留在手里，测试里手动"点托盘"。 */
function installBridge(options: { reportThrowsOnce?: boolean; withoutOnCommand?: boolean } = {}) {
  let throwOnce = options.reportThrowsOnce === true;
  const reportStatus = vi.fn((_status: ShellStatus) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('桥断了');
    }
  });
  let callback: CommandCallback | null = null;
  const unsubscribe = vi.fn(() => {
    callback = null;
  });
  const onCommand = vi.fn((cb: CommandCallback) => {
    callback = cb;
    return unsubscribe;
  });

  const bridge: Record<string, unknown> = { reportStatus };
  if (!options.withoutOnCommand) bridge.onCommand = onCommand;
  (globalThis as unknown as { qingyinDesktop?: unknown }).qingyinDesktop = bridge;

  return {
    onCommand,
    reportStatus,
    unsubscribe,
    /** 模拟用户点了托盘菜单里的某一项。 */
    click: (type: string) => callback?.({ type }),
    /** 模拟壳层发来一个畸形载荷。 */
    clickRaw: (payload: unknown) => callback?.(payload as { type: string }),
    subscribed: () => callback !== null,
    lastStatus: (): ShellStatus | null => {
      const calls = reportStatus.mock.calls;
      return calls.length > 0 ? (calls[calls.length - 1][0] as ShellStatus) : null;
    },
  };
}

/** 每个用例都要一套全新的模块图（store 与 desktopShell 必须来自同一次 import）。 */
async function freshModules() {
  vi.resetModules();
  const store = await import('./store.js');
  const shell = await import('./desktopShell.js');
  return { useAppStore: store.useAppStore, startDesktopShell: shell.startDesktopShell };
}

/** 把三个播放动作换成 spy：命令有没有落对地方，看它们各被调了几次。 */
function spyActions(useAppStore: Awaited<ReturnType<typeof freshModules>>['useAppStore']) {
  const togglePlay = vi.fn(async () => {});
  const previous = vi.fn(async () => {});
  const next = vi.fn(async () => {});
  useAppStore.setState({ togglePlay, previous, next });
  return { togglePlay, previous, next };
}

afterEach(() => {
  delete (globalThis as unknown as { qingyinDesktop?: unknown }).qingyinDesktop;
  vi.restoreAllMocks();
});

describe('没有桌面壳（浏览器 / PWA）：零副作用', () => {
  it('桥不存在：不抛、返回 false、不订阅 store、不上报', async () => {
    const { useAppStore, startDesktopShell } = await freshModules();
    const subscribe = vi.spyOn(useAppStore, 'subscribe');

    expect(() => startDesktopShell()).not.toThrow();
    expect(startDesktopShell()).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('桥残缺（没有 onCommand）：不订阅、不发上报', async () => {
    const bridge = installBridge({ withoutOnCommand: true });
    const { useAppStore, startDesktopShell } = await freshModules();
    const subscribe = vi.spyOn(useAppStore, 'subscribe');

    expect(startDesktopShell()).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(bridge.reportStatus).not.toHaveBeenCalled();
  });

  it('桥是垃圾值（字符串 / null / 数字）：不抛，也不订阅', async () => {
    const { useAppStore, startDesktopShell } = await freshModules();
    const subscribe = vi.spyOn(useAppStore, 'subscribe');
    const holder = globalThis as unknown as { qingyinDesktop?: unknown };

    for (const junk of ['nope', null, 42]) {
      holder.qingyinDesktop = junk;
      expect(startDesktopShell()).toBe(false);
    }
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('没装桥时改播放状态也不会冒出任何上报（web 行为不变的正面验证）', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    // 先把桥摘掉，模拟浏览器：即使 globalThis 上曾经有过，也不该留下订阅
    delete (globalThis as unknown as { qingyinDesktop?: unknown }).qingyinDesktop;
    startDesktopShell();
    expect(() => useAppStore.setState({ playing: true })).not.toThrow();
    expect(bridge.reportStatus).not.toHaveBeenCalled();
    expect(bridge.onCommand).not.toHaveBeenCalled();
  });
});

describe('有桌面壳：命令只落到既有 store 动作', () => {
  it('play-pause → 只调 togglePlay，不碰 previous/next', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    const spies = spyActions(useAppStore);

    expect(startDesktopShell()).toBe(true);
    bridge.click('play-pause');

    expect(spies.togglePlay).toHaveBeenCalledTimes(1);
    expect(spies.previous).not.toHaveBeenCalled();
    expect(spies.next).not.toHaveBeenCalled();
  });

  it('prev → 只调 previous', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    const spies = spyActions(useAppStore);

    startDesktopShell();
    bridge.click('prev');

    expect(spies.previous).toHaveBeenCalledTimes(1);
    expect(spies.togglePlay).not.toHaveBeenCalled();
    expect(spies.next).not.toHaveBeenCalled();
  });

  it('next → 只调 next', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    const spies = spyActions(useAppStore);

    startDesktopShell();
    bridge.click('next');

    expect(spies.next).toHaveBeenCalledTimes(1);
    expect(spies.togglePlay).not.toHaveBeenCalled();
    expect(spies.previous).not.toHaveBeenCalled();
  });

  it('未知命令类型 / 畸形载荷：什么都不调，也不抛', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    const spies = spyActions(useAppStore);

    startDesktopShell();
    for (const type of ['quit', 'PLAY-PAUSE', 'stop', '']) {
      expect(() => bridge.click(type)).not.toThrow();
    }
    expect(() => bridge.clickRaw(null)).not.toThrow();
    expect(() => bridge.clickRaw({})).not.toThrow();
    expect(() => bridge.clickRaw({ type: 42 })).not.toThrow();

    expect(spies.togglePlay).not.toHaveBeenCalled();
    expect(spies.previous).not.toHaveBeenCalled();
    expect(spies.next).not.toHaveBeenCalled();
  });
});

describe('播放状态上报', () => {
  it('启动即报一次，载荷形状恰好是四个键', async () => {
    const bridge = installBridge();
    const { startDesktopShell } = await freshModules();

    startDesktopShell();

    expect(bridge.reportStatus).toHaveBeenCalledTimes(1);
    const status = bridge.lastStatus();
    expect(status).toEqual({ playing: false, currentIndex: -1, queueLength: 0, hasTrack: false });
    expect(Object.keys(status ?? {}).sort()).toEqual(['currentIndex', 'hasTrack', 'playing', 'queueLength']);
  });

  it('playing 变化 → 上报；音量这类无关变化 → 不上报', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    startDesktopShell();
    expect(bridge.reportStatus).toHaveBeenCalledTimes(1);

    // 与本功能无关的变化：音量、静音、抽屉、检索词、通知
    useAppStore.setState({ volume: 0.42, muted: true, drawer: 'queue', query: '随便搜点什么' });
    expect(bridge.reportStatus).toHaveBeenCalledTimes(1);

    // 菜单关心的变化：播放中 → 暂停中
    useAppStore.setState({ playing: true });
    expect(bridge.reportStatus).toHaveBeenCalledTimes(2);
    expect(bridge.lastStatus()?.playing).toBe(true);

    useAppStore.setState({ playing: false });
    expect(bridge.reportStatus).toHaveBeenCalledTimes(3);
    expect(bridge.lastStatus()?.playing).toBe(false);
  });

  it('队列与当前曲目变化 → 上报（菜单禁用态依赖 hasTrack）', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    startDesktopShell();
    expect(bridge.lastStatus()?.hasTrack).toBe(false);

    useAppStore.setState({ queue: ['a.mp3', 'b.mp3', 'c.mp3'], currentIndex: 1 });
    expect(bridge.lastStatus()).toEqual({ playing: false, currentIndex: 1, queueLength: 3, hasTrack: true });

    // 队列被清空 → hasTrack 回到 false，托盘三项该重新禁用
    useAppStore.setState({ queue: [], currentIndex: -1 });
    expect(bridge.lastStatus()?.hasTrack).toBe(false);
  });

  it('同一个状态重复 set 不会重复上报（去重看的是值，不是引用）', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    startDesktopShell();

    useAppStore.setState({ playing: true });
    const after = bridge.reportStatus.mock.calls.length;
    useAppStore.setState({ playing: true });
    useAppStore.setState({ volume: 0.9 });
    expect(bridge.reportStatus.mock.calls.length).toBe(after);
  });

  it('reportStatus 抛错（壳层异常）不能中断订阅，后续变化照样上报', async () => {
    const bridge = installBridge({ reportThrowsOnce: true });
    const { useAppStore, startDesktopShell } = await freshModules();

    expect(() => startDesktopShell()).not.toThrow();
    useAppStore.setState({ playing: true });
    expect(bridge.reportStatus).toHaveBeenCalledTimes(2);
    expect(bridge.lastStatus()?.playing).toBe(true);
  });

  it('命令动作抛错（同步异常 + rejection）不冒泡，且不影响后续命令与上报', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    const rejecting = vi.fn(async () => {
      throw new Error('播放引擎炸了');
    });
    const throwing = vi.fn((): Promise<void> => {
      throw new Error('同步炸');
    });
    useAppStore.setState({ next: rejecting, togglePlay: throwing });
    startDesktopShell();

    // 命令是从壳层的 IPC 派发处调进来的：抛出去就是"未处理的 rejection"，
    // 用户什么也看不见，所以必须在接缝处吞掉
    expect(() => bridge.click('next')).not.toThrow();
    expect(() => bridge.click('play-pause')).not.toThrow();
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);

    // 出过错之后订阅还活着：状态变化照样上报，命令照样能再发
    useAppStore.setState({ playing: true });
    expect(bridge.reportStatus).toHaveBeenCalledTimes(2);
    bridge.click('next');
    expect(rejecting).toHaveBeenCalledTimes(2);

    // 让被吞掉的 rejection 走完，测试进程不该报未处理 rejection
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('幂等（HMR 会重跑入口）', () => {
  it('startDesktopShell 调多次只订阅一次，一条命令只放一次', async () => {
    const bridge = installBridge();
    const { useAppStore, startDesktopShell } = await freshModules();
    const spies = spyActions(useAppStore);

    expect(startDesktopShell()).toBe(true);
    expect(startDesktopShell()).toBe(true);
    expect(startDesktopShell()).toBe(true);
    expect(bridge.onCommand).toHaveBeenCalledTimes(1);
    expect(bridge.reportStatus).toHaveBeenCalledTimes(1);

    bridge.click('next');
    expect(spies.next).toHaveBeenCalledTimes(1);

    useAppStore.setState({ playing: true });
    expect(bridge.reportStatus).toHaveBeenCalledTimes(2);
  });
});
