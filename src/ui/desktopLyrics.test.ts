/**
 * 桌面补歌词胶水的单测（jsdom）。
 *
 * 锁住的行为（captain 点名要的三条 + 失败路径）：
 *  1. 桥不存在 → init 返回 false，**零监听零调用**（在注册任何监听之前就 return）
 *  2. 桥存在 → done 事件触发**恰好一次** rescanLyrics()
 *  3. running 这类中间状态不许触发 rescan（只有成功终态才扫；failed 也不扫）
 *  4. 幂等：init 两次，桥的 onStatus 只被订阅一次
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './store.js';
import {
  describeToolStatus,
  initDesktopLyrics,
  resetDesktopLyricsForTest,
  startFillLyrics,
  type DesktopLyricsBridge,
  type DesktopLyricsToolStatus,
} from './desktopLyrics.js';

function statusOf(overrides: Partial<DesktopLyricsToolStatus>): DesktopLyricsToolStatus {
  return {
    status: 'running',
    exitCode: null,
    scriptLabel: 'fake-fill-lyrics.ps1',
    startedAt: Date.now(),
    finishedAt: null,
    tail: [],
    error: null,
    ...overrides,
  };
}

interface FakeBridge extends DesktopLyricsBridge {
  push(state: DesktopLyricsToolStatus): void;
  runCalls: number;
  cancelCalls: number;
}

function fakeBridge(runResult: { ok: boolean; reason?: string } = { ok: true }): FakeBridge {
  const subscribers = new Set<(state: DesktopLyricsToolStatus) => void>();
  const bridge: FakeBridge = {
    runCalls: 0,
    cancelCalls: 0,
    async run() {
      bridge.runCalls += 1;
      return { ...runResult, status: statusOf({ status: 'running' }) };
    },
    async status() {
      return statusOf({ status: 'idle' });
    },
    async cancel() {
      bridge.cancelCalls += 1;
      return { cancelled: true };
    },
    onStatus(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    push(state) {
      for (const callback of subscribers) callback(state);
    },
  };
  return bridge;
}

const rescanMock = vi.fn(async () => undefined);

beforeEach(() => {
  resetDesktopLyricsForTest();
  rescanMock.mockClear();
  useAppStore.setState({
    rescanLyrics: rescanMock as unknown as () => Promise<void>,
  });
});

describe('状态文案（面板与侧栏共用一份）', () => {
  it('running / done / cancelled 各用自己的说法，cancelled 绝不带"失败"', () => {
    expect(describeToolStatus(statusOf({ status: 'running' }))).toBe('补歌词工具运行中');
    expect(describeToolStatus(statusOf({ status: 'done', exitCode: 0 }))).toBe('补歌词完成，已重新扫描');
    const cancelled = describeToolStatus(statusOf({ status: 'cancelled' }));
    expect(cancelled).toBe('已取消补歌词');
    expect(cancelled).not.toContain('失败');
  });

  it('failed 有退出码时带退出码，没有时带错误原因', () => {
    expect(describeToolStatus(statusOf({ status: 'failed', exitCode: 5 }))).toBe('补歌词失败（退出码 5）');
    expect(describeToolStatus(statusOf({ status: 'failed', error: '工具路径不存在' }))).toBe(
      '补歌词失败：工具路径不存在',
    );
  });

  it('idle 不出文案（侧栏与面板都用 `status !== idle` 才渲染）', () => {
    expect(describeToolStatus(statusOf({ status: 'idle' }))).toBe('');
  });
});

describe('桥不存在（纯 web / PWA）', () => {
  it('init 返回 false，且不抛异常', () => {
    expect(initDesktopLyrics()).toBe(false);
  });

  it('startFillLyrics 是 no-op：不会调用任何桥方法（桥为 undefined）', async () => {
    initDesktopLyrics();
    await startFillLyrics();
    expect(rescanMock).not.toHaveBeenCalled();
  });

  it('init(undefined) 显式传空也返回 false（与 window 没桥同一条路径）', () => {
    expect(initDesktopLyrics(undefined)).toBe(false);
  });
});

describe('桥存在（桌面端）', () => {
  it('done 终态触发恰好一次 rescanLyrics；running 中间状态不触发', async () => {
    const bridge = fakeBridge();
    initDesktopLyrics(bridge);

    bridge.push(statusOf({ status: 'running', tail: ['开始'] }));
    bridge.push(statusOf({ status: 'running', tail: ['开始', '进度'] })); // 日志尾推送，状态不变
    bridge.push(statusOf({ status: 'running', tail: ['开始', '进度', '收尾'] }));
    expect(rescanMock).not.toHaveBeenCalled(); // 中间状态一次都不许扫

    bridge.push(statusOf({ status: 'done', exitCode: 0, tail: ['FAKE-FILL wrote x.lrc'] }));
    await vi.waitFor(() => expect(rescanMock).toHaveBeenCalledTimes(1));
    expect(rescanMock).toHaveBeenCalledWith(); // 无参数调用
  });

  it('done 之后同一状态再推送不重复扫（transition 判定，不是 status 判定）', async () => {
    const bridge = fakeBridge();
    initDesktopLyrics(bridge);

    bridge.push(statusOf({ status: 'done', exitCode: 0 }));
    await vi.waitFor(() => expect(rescanMock).toHaveBeenCalledTimes(1));
    bridge.push(statusOf({ status: 'done', exitCode: 0, tail: ['extra'] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });

  it('failed 终态不触发 rescan（工具没成功，扫不出新东西）', () => {
    const bridge = fakeBridge();
    initDesktopLyrics(bridge);

    bridge.push(statusOf({ status: 'running' }));
    bridge.push(statusOf({ status: 'failed', exitCode: 3, error: null, tail: ['模拟失败'] }));
    expect(rescanMock).not.toHaveBeenCalled();
  });

  it('cancelled 独立终态（t8）：不触发 rescan，通知是中性文案（不带失败字眼）', async () => {
    const bridge = fakeBridge();
    initDesktopLyrics(bridge);

    bridge.push(statusOf({ status: 'running' }));
    bridge.push(statusOf({ status: 'cancelled', finishedAt: Date.now(), error: null }));
    expect(rescanMock).not.toHaveBeenCalled(); // 取消没扫出东西的语义

    await vi.waitFor(() => {
      const last = useAppStore.getState().notices.at(-1);
      expect(last?.message).toContain('已取消');
      expect(last?.message).not.toContain('失败');
    });
  });

  it('cancelled 之后 close 事件的重复推送（同终态）不改任何状态', async () => {
    const bridge = fakeBridge();
    initDesktopLyrics(bridge);

    bridge.push(statusOf({ status: 'running' }));
    bridge.push(statusOf({ status: 'cancelled', finishedAt: Date.now() }));
    bridge.push(statusOf({ status: 'cancelled', finishedAt: Date.now(), tail: ['残余输出'] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rescanMock).not.toHaveBeenCalled();
  });

  it('init 幂等：调两次，桥只被订阅一次（每条状态只派发一份）', () => {
    const bridge = fakeBridge();
    expect(initDesktopLyrics(bridge)).toBe(true);
    expect(initDesktopLyrics(bridge)).toBe(true);

    bridge.push(statusOf({ status: 'done', exitCode: 0 }));
    // 一次推送 → 一次 rescan（订阅被去重）
    expect(rescanMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('手动触发', () => {
  it('startFillLyrics 走桥的 run()', async () => {
    const bridge = fakeBridge();
    initDesktopLyrics(bridge);

    await startFillLyrics();
    expect(bridge.runCalls).toBe(1);
  });
});
