/**
 * 播放编排：把 core 的纯逻辑（模式推进、洗牌、队列）接到真正的播放引擎上。
 *
 * 这一层刻意做成"环境注入"的形式（`PlaybackEnv`），于是下面这些最容易出错的行为
 * 可以在 Node 里用假引擎与假曲库测出来：
 *  - 双击某首 = 以当前可见列表为队列，从该首开始
 *  - 自然播放结束与手动「下一首」在单曲循环下行为不同（技术方案 4.5）
 *  - 不可播放的曲目自动跳过，而不是弹错误框（技术方案 8.2）
 *  - 顺序播放走到末尾就停下并提示，不静默绕回
 *  - 全部不可播放时最多走一圈就停，不会死循环
 */
import {
  findPlayableIndex,
  resolveNextIndex,
  resolvePrevIndex,
  shuffleOrder as makeShuffleOrder,
} from '../core/queue.js';
import type { PlayMode } from '../core/queue.js';
import type { Track } from '../core/track.js';

/** 与 `createAudioEngine()` 返回的对象结构兼容；测试里用假实现替换。 */
export interface PlaybackEngine {
  load(request: {
    path: string;
    blob?: Blob;
    url?: string;
    positionSec?: number;
    autoplay?: boolean;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(positionSec: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  readonly paused: boolean;
  readonly currentPath: string | undefined;
  readonly positionSec: number;
  readonly durationSec: number;
}

export interface TrackSource {
  blob?: Blob;
  url?: string;
}

export interface PlaybackSnapshot {
  queue: string[];
  currentIndex: number;
  mode: PlayMode;
  shuffleOrder: number[];
}

export interface PlaybackEnv {
  getPlayback(): PlaybackSnapshot;
  setPlayback(patch: Partial<PlaybackSnapshot>): void;
  getTrack(path: string): Track | undefined;
  openSource(track: Track): Promise<TrackSource | undefined>;
  getEngine(): PlaybackEngine;
  onPlayingChange(playing: boolean): void;
  /** 切歌时通知：MediaSession 元数据与「上次播到哪儿」的持久化。 */
  onTrackChange(track: Track | undefined, positionSec: number): void;
  /** 播放进度变化：只做节流持久化，绝不能触发界面整体重渲染（技术方案 7.2）。 */
  onProgress(track: Track | undefined, positionSec: number): void;
  onNotice(message: string, kind: 'info' | 'warn'): void;
}

export interface PlaybackController {
  /** 以 paths 为队列，从 startIndex 开始播放（双击某首走这里）。 */
  start(
    paths: string[],
    startIndex: number,
    options?: { positionSec?: number; autoplay?: boolean },
  ): Promise<void>;
  toggle(): Promise<void>;
  next(options?: { auto?: boolean }): Promise<void>;
  previous(): Promise<void>;
  seek(positionSec: number): void;
  /** 切到随机模式时重新洗牌，避免连续重复同一首。 */
  reshuffle(): void;
}

export function createPlaybackController(env: PlaybackEnv): PlaybackController {
  const isPlayable = (path: string): boolean => env.getTrack(path)?.verdict === 'decodable';

  async function loadAt(
    index: number,
    options: { autoplay: boolean; positionSec?: number },
  ): Promise<void> {
    const { queue } = env.getPlayback();
    const path = queue[index];
    const track = path ? env.getTrack(path) : undefined;
    if (!track) {
      env.onTrackChange(undefined, 0);
      return;
    }

    const source = await env.openSource(track);
    if (!source) {
      env.onNotice(`打开失败：${track.title}`, 'warn');
      env.onTrackChange(undefined, 0);
      return;
    }

    env.setPlayback({ currentIndex: index });
    env.onTrackChange(track, options.positionSec ?? 0);

    await env.getEngine().load({
      path: track.path,
      ...source,
      positionSec: options.positionSec,
      autoplay: options.autoplay,
    });
  }

  /** 沿当前模式往前走，跳过不可播放的曲目。最多走一圈，避免全部不可播放时死循环。 */
  async function advance(direction: 'next' | 'prev', auto: boolean): Promise<void> {
    const { queue, currentIndex, mode, shuffleOrder } = env.getPlayback();
    const length = queue.length;
    if (length === 0) {
      env.onNotice('播放队列是空的', 'info');
      return;
    }

    if (currentIndex < 0) {
      const first = findPlayableIndex(length, 0, (index) => isPlayable(queue[index]!));
      if (first === -1) {
        env.onNotice('队列里没有可播放的曲目', 'warn');
        return;
      }
      await loadAt(first, { autoplay: true });
      return;
    }

    let cursor = currentIndex;
    let skipped = 0;

    for (let step = 0; step <= length; step += 1) {
      const target =
        direction === 'next'
          ? resolveNextIndex({
              mode,
              currentIndex: cursor,
              queueLength: length,
              order: shuffleOrder,
              // 只有第一步可能是"自然播放结束"：后续跳过都是显式动作
              auto: auto && step === 0,
            })
          : resolvePrevIndex({
              mode,
              currentIndex: cursor,
              queueLength: length,
              order: shuffleOrder,
            });

      if (target === -1) {
        env.getEngine().pause();
        env.onNotice('已播放到列表末尾', 'info');
        return;
      }

      const path = queue[target]!;
      if (isPlayable(path)) {
        await loadAt(target, { autoplay: true });
        return;
      }

      const track = env.getTrack(path);
      if (track) {
        env.onNotice(`${track.title}：${track.verdictNote ?? '浏览器无法解码'}`, 'warn');
      }
      cursor = target;
      skipped += 1;
      if (cursor === currentIndex || skipped >= length) break;
    }

    env.getEngine().pause();
    env.onNotice('队列里没有可播放的曲目', 'warn');
  }

  return {
    async start(paths, startIndex, options = {}) {
      const queue = [...paths];
      if (queue.length === 0) {
        env.onNotice('没有可播放的曲目', 'warn');
        return;
      }

      env.setPlayback({
        queue,
        currentIndex: -1,
        shuffleOrder: makeShuffleOrder(queue.length),
      });

      const from = Math.max(0, Math.min(startIndex, queue.length - 1));
      const playable = findPlayableIndex(queue.length, from, (index) => isPlayable(queue[index]!));
      if (playable === -1) {
        env.onNotice('队列里没有可播放的曲目', 'warn');
        return;
      }
      if (playable !== from) {
        const skipped = env.getTrack(queue[from]!);
        if (skipped) {
          env.onNotice(`${skipped.title}：${skipped.verdictNote ?? '浏览器无法解码'}`, 'warn');
        }
      }

      await loadAt(playable, {
        autoplay: options.autoplay ?? true,
        positionSec: options.positionSec,
      });
    },

    async toggle() {
      const engine = env.getEngine();
      const { queue, currentIndex } = env.getPlayback();

      if (currentIndex < 0 || !engine.currentPath) {
        const first = findPlayableIndex(queue.length, 0, (index) => isPlayable(queue[index]!));
        if (first === -1) {
          env.onNotice('还没有可播放的曲目', 'info');
          return;
        }
        await loadAt(first, { autoplay: true });
        return;
      }

      if (engine.paused) await engine.play();
      else engine.pause();
    },

    async next(options = {}) {
      await advance('next', options.auto ?? false);
    },

    async previous() {
      await advance('prev', false);
    },

    seek(positionSec) {
      env.getEngine().seek(positionSec);
      const { queue, currentIndex } = env.getPlayback();
      const path = queue[currentIndex];
      env.onProgress(path ? env.getTrack(path) : undefined, positionSec);
    },

    reshuffle() {
      const { queue } = env.getPlayback();
      env.setPlayback({ shuffleOrder: makeShuffleOrder(queue.length) });
    },
  };
}
