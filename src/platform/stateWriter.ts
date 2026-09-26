/**
 * 播放状态的节流写入（技术方案 8.4）。
 *
 * 播放进度不能每秒写一次 IndexedDB，所以约定：
 *  - 音量、播放模式这类低频变化：变化即写（`saveNow`）
 *  - 当前曲目与进度：`save` 走节流（默认 5s），另外在暂停时、切歌时、
 *    页面 `visibilitychange` 隐藏时各 `flush()` 一次
 *
 * 定时器与时钟都以参数注入，于是"节流"这件事本身可以被单测锁住，
 * 而不是靠肉眼看代码。
 */
import type { LibraryStorage, PlaybackState } from './storage.js';

export interface StateWriterOptions {
  throttleMs?: number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface StateWriter {
  /** 节流写入：多次调用只落最后一次。 */
  save(state: PlaybackState): void;
  /** 立即写入：音量、模式这类低频变化用。 */
  saveNow(state: PlaybackState): Promise<void>;
  /** 把待写入的内容立刻落盘（暂停、切歌、页面隐藏时调用）。 */
  flush(): Promise<void>;
  /** 丢弃待写入内容并停掉定时器。 */
  dispose(): void;
  readonly pending: boolean;
}

export function createStateWriter(
  storage: LibraryStorage,
  options: StateWriterOptions = {},
): StateWriter {
  const throttleMs = options.throttleMs ?? 5000;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  let pendingState: PlaybackState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function write(state: PlaybackState | undefined): Promise<void> {
    if (!state) return;
    await storage.writeState(state);
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  return {
    get pending() {
      return pendingState !== undefined;
    },

    save(state) {
      pendingState = state;
      if (timer !== undefined) return;
      timer = setTimer(() => {
        timer = undefined;
        const next = pendingState;
        pendingState = undefined;
        void write(next);
      }, throttleMs);
    },

    async saveNow(state) {
      pendingState = undefined;
      stopTimer();
      await write(state);
    },

    async flush() {
      stopTimer();
      const next = pendingState;
      pendingState = undefined;
      await write(next);
    },

    dispose() {
      stopTimer();
      pendingState = undefined;
    },
  };
}
