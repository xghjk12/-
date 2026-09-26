/**
 * 播放编排的行为锁定（M2 的验收标准）。
 *
 * 用假引擎 + 假曲库把最容易出错的地方固定住：
 *  - 双击某首 = 以当前可见列表为队列，从该首开始
 *  - 单曲循环在**自然播放结束**时重复本首，手动「下一首」仍前进（技术方案 4.5）
 *  - 不可播放的曲目自动跳到下一首可播放的，而不是弹错误框（技术方案 8.2）
 *  - 顺序播放走到末尾就停并提示；全部不可播放时最多走一圈，不死循环
 */
import { describe, expect, it } from 'vitest';
import type { Track } from '../core/track.js';
import type { PlayMode } from '../core/queue.js';
import { createPlaybackController } from './playback.js';
import type { PlaybackEngine, PlaybackEnv, PlaybackSnapshot } from './playback.js';

class FakeEngine implements PlaybackEngine {
  loaded: Array<{ path: string; autoplay?: boolean; positionSec?: number }> = [];
  paused = true;
  currentPath: string | undefined;
  positionSec = 0;
  durationSec = 180;

  async load(request: {
    path: string;
    autoplay?: boolean;
    positionSec?: number;
  }): Promise<void> {
    // 只记录关心的字段：blob 是测试里现造的，比较它没有意义
    this.loaded.push({
      path: request.path,
      autoplay: request.autoplay,
      positionSec: request.positionSec,
    });
    this.currentPath = request.path;
    this.paused = request.autoplay === false;
  }

  async play(): Promise<void> {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  seek(positionSec: number): void {
    this.positionSec = positionSec;
  }

  setVolume(): void {}
  setMuted(): void {}
}

function track(path: string, verdict: 'decodable' | 'metadata-only' = 'decodable'): Track {
  return {
    path,
    name: path,
    size: 1024,
    lastModified: 1,
    cacheKey: `${path}\u00001024\u00001`,
    title: path,
    titleFromFileName: false,
    durationSec: 180,
    extension: path.split('.').pop() ?? 'mp3',
    verdict,
    verdictNote: verdict === 'metadata-only' ? '浏览器无法解码该格式' : undefined,
    hasCover: false,
    addedAt: 1,
  };
}

function setup(tracks: Track[], mode: PlayMode = 'sequence', options: { failOpen?: boolean } = {}) {
  const engine = new FakeEngine();
  const snapshot: PlaybackSnapshot = {
    queue: [],
    currentIndex: -1,
    mode,
    shuffleOrder: [],
  };
  const notices: string[] = [];
  const trackChanges: Array<string | undefined> = [];
  const progress: Array<{ path?: string; position: number }> = [];

  const env: PlaybackEnv = {
    getPlayback: () => ({ ...snapshot }),
    setPlayback: (patch) => Object.assign(snapshot, patch),
    getTrack: (path) => tracks.find((item) => item.path === path),
    openSource: async (item) => (options.failOpen ? undefined : { blob: new Blob([item.path]) }),
    getEngine: () => engine,
    onPlayingChange: () => {},
    onTrackChange: (item, position) => {
      trackChanges.push(item?.path);
      progress.push({ path: item?.path, position });
    },
    onProgress: (item, position) => progress.push({ path: item?.path, position }),
    onNotice: (message) => notices.push(message),
  };

  return {
    controller: createPlaybackController(env),
    engine,
    snapshot,
    notices,
    trackChanges,
    progress,
  };
}

const PATHS = ['a.mp3', 'b.mp3', 'c.mp3'];

describe('start：双击某首即从该处顺序播放', () => {
  it('队列等于传入的可见列表，并从该下标开始', async () => {
    const { controller, engine, snapshot } = setup(PATHS.map((path) => track(path)));

    await controller.start(PATHS, 1);

    expect(snapshot.queue).toEqual(PATHS);
    expect(snapshot.currentIndex).toBe(1);
    expect(engine.loaded).toEqual([{ path: 'b.mp3', autoplay: true, positionSec: undefined }]);
    expect(snapshot.shuffleOrder).toHaveLength(3);
  });

  it('恢复上次播放时不自动播放，并带上进度', async () => {
    const { controller, engine } = setup(PATHS.map((path) => track(path)));

    await controller.start(PATHS, 0, { positionSec: 42, autoplay: false });

    expect(engine.loaded[0]).toMatchObject({ path: 'a.mp3', autoplay: false, positionSec: 42 });
    expect(engine.paused).toBe(true);
  });

  it('起始曲目不可播放时跳到下一首可播放的，并给出说明', async () => {
    const tracks = [track('a.ape', 'metadata-only'), track('b.mp3'), track('c.mp3')];
    const { controller, engine, notices } = setup(tracks);

    await controller.start(
      tracks.map((item) => item.path),
      0,
    );

    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.path).toBe('b.mp3');
    expect(notices[0]).toContain('浏览器无法解码');
  });

  it('整队都不可播放时不加载任何曲目', async () => {
    const tracks = [track('a.ape', 'metadata-only'), track('b.wv', 'metadata-only')];
    const { controller, engine, notices } = setup(tracks);

    await controller.start(
      tracks.map((item) => item.path),
      0,
    );

    expect(engine.loaded).toEqual([]);
    expect(notices.at(-1)).toContain('没有可播放的曲目');
  });

  it('打开来源失败时给出提示而不是抛异常', async () => {
    const { controller, engine, notices } = setup([track('a.mp3')], 'sequence', { failOpen: true });

    await controller.start(['a.mp3'], 0);

    expect(engine.loaded).toEqual([]);
    expect(notices.at(-1)).toContain('打开失败');
  });
});

describe('next：自然结束与手动切歌的区别', () => {
  it('单曲循环：自然播放结束重复本首', async () => {
    const { controller, engine } = setup(PATHS.map((path) => track(path)), 'repeat-one');
    await controller.start(PATHS, 1);
    engine.loaded.length = 0;

    await controller.next({ auto: true });

    expect(engine.loaded[0]?.path).toBe('b.mp3');
  });

  it('单曲循环：手动点「下一首」仍然前进', async () => {
    const { controller, engine } = setup(PATHS.map((path) => track(path)), 'repeat-one');
    await controller.start(PATHS, 1);
    engine.loaded.length = 0;

    await controller.next();

    expect(engine.loaded[0]?.path).toBe('c.mp3');
  });

  it('列表循环：最后一首之后回到第一首', async () => {
    const { controller, engine } = setup(PATHS.map((path) => track(path)), 'repeat-all');
    await controller.start(PATHS, 2);
    engine.loaded.length = 0;

    await controller.next();

    expect(engine.loaded[0]?.path).toBe('a.mp3');
  });

  it('顺序播放：末尾停下并提示，不静默绕回', async () => {
    const { controller, engine, notices } = setup(PATHS.map((path) => track(path)), 'sequence');
    await controller.start(PATHS, 2);
    engine.loaded.length = 0;

    await controller.next();

    expect(engine.loaded).toEqual([]);
    expect(engine.paused).toBe(true);
    expect(notices.at(-1)).toContain('已播放到列表末尾');
  });

  it('随机：按洗牌序列推进，走完一轮回到序列开头', async () => {
    const { controller, engine, snapshot } = setup(PATHS.map((path) => track(path)), 'shuffle');
    await controller.start(PATHS, 0);
    // 注入确定性序列：0 → 2 → 1
    Object.assign(snapshot, { queue: PATHS, currentIndex: 0, shuffleOrder: [0, 2, 1] });
    engine.loaded.length = 0;

    await controller.next();
    expect(engine.loaded.at(-1)?.path).toBe('c.mp3');

    await controller.next();
    expect(engine.loaded.at(-1)?.path).toBe('b.mp3');

    await controller.next();
    expect(engine.loaded.at(-1)?.path).toBe('a.mp3');
  });

  it('跳过队列中间不可播放的曲目，并逐条给出提示', async () => {
    const tracks = [track('a.mp3'), track('b.ape', 'metadata-only'), track('c.mp3')];
    const { controller, engine, notices } = setup(tracks);
    await controller.start(
      tracks.map((item) => item.path),
      0,
    );
    engine.loaded.length = 0;

    await controller.next();

    expect(engine.loaded[0]?.path).toBe('c.mp3');
    expect(notices.some((message) => message.includes('b.ape'))).toBe(true);
  });

  it('整队不可播放时最多走一圈就停下（不死循环）', async () => {
    const tracks = [track('a.ape', 'metadata-only'), track('b.ape', 'metadata-only')];
    const { controller, engine, notices, snapshot } = setup(tracks, 'repeat-all');
    Object.assign(snapshot, { queue: ['a.ape', 'b.ape'], currentIndex: 0 });
    engine.currentPath = 'a.ape';

    // 循环有界，所以这里必然返回；如果实现里跑了死循环，测试会超时失败
    await controller.next();

    expect(engine.loaded).toEqual([]);
    expect(engine.paused).toBe(true);
    expect(notices.some((message) => message.includes('没有可播放'))).toBe(true);
  });
});

describe('previous 与 seek', () => {
  it('顺序模式：第一首的上一首停在第一首', async () => {
    const { controller, engine } = setup(PATHS.map((path) => track(path)), 'sequence');
    await controller.start(PATHS, 0);
    engine.loaded.length = 0;

    await controller.previous();

    expect(engine.loaded[0]?.path).toBe('a.mp3');
  });

  it('列表循环：第一首的上一首回到最后一首', async () => {
    const { controller, engine } = setup(PATHS.map((path) => track(path)), 'repeat-all');
    await controller.start(PATHS, 0);
    engine.loaded.length = 0;

    await controller.previous();

    expect(engine.loaded[0]?.path).toBe('c.mp3');
  });

  it('seek 落到引擎上，并把进度回调出去（用于持久化）', () => {
    const { controller, engine, progress, snapshot } = setup(PATHS.map((path) => track(path)));
    Object.assign(snapshot, { queue: PATHS, currentIndex: 0 });

    controller.seek(77);

    expect(engine.positionSec).toBe(77);
    expect(progress.at(-1)).toEqual({ path: 'a.mp3', position: 77 });
  });
});

describe('toggle 与 reshuffle', () => {
  it('还没有当前曲目时，toggle 从第一首可播放的开始', async () => {
    const tracks = [track('a.ape', 'metadata-only'), track('b.mp3')];
    const { controller, engine, snapshot } = setup(tracks);
    Object.assign(snapshot, { queue: tracks.map((item) => item.path), currentIndex: -1 });

    await controller.toggle();

    expect(engine.loaded[0]?.path).toBe('b.mp3');
  });

  it('已有当前曲目时，toggle 在播放与暂停之间切换', async () => {
    const { controller, engine, snapshot } = setup([track('a.mp3')]);
    Object.assign(snapshot, { queue: ['a.mp3'], currentIndex: 0 });
    engine.currentPath = 'a.mp3';
    engine.paused = true;

    await controller.toggle();
    expect(engine.paused).toBe(false);

    await controller.toggle();
    expect(engine.paused).toBe(true);
  });

  it('reshuffle 产生 0..n-1 的一个排列', () => {
    const { controller, snapshot } = setup(PATHS.map((path) => track(path)));
    Object.assign(snapshot, { queue: PATHS, currentIndex: 0 });

    controller.reshuffle();

    expect([...snapshot.shuffleOrder].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});
