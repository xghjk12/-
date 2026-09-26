/**
 * 播放引擎测试：用假元素把「不碰真浏览器也能验证」的那部分锁住。
 *
 * 最关键的一条是对象 URL 的生命周期——切歌不 revoke 的话，每听过一首歌就会钉住一块内存，
 * 这种问题在真浏览器里几乎看不出来，只能靠测试守。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAudioEngine } from './audioEngine.js';
import type { AudioEngineDeps } from './audioEngine.js';

type Handler = (event?: unknown) => void;

/** 最小可用的假 <audio>：只实现引擎真正用到的那几个成员。 */
class FakeAudio {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  volume = 1;
  muted = false;
  error: { code?: number; message?: string } | null = null;
  playCalls = 0;
  pauseCalls = 0;
  private listeners = new Map<string, Set<Handler>>();

  addEventListener(type: string, handler: Handler): void {
    const set = this.listeners.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    this.dispatch('play');
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatch('pause');
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

function setup() {
  const element = new FakeAudio();
  const created: string[] = [];
  const revoked: string[] = [];
  const deps: AudioEngineDeps = {
    createElement: () => element as unknown as HTMLAudioElement,
    createObjectURL: () => {
      const url = `blob:track-${created.length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
  };
  return { element, deps, created, revoked };
}

const blob = (text = 'audio'): Blob => new Blob([text]);

describe('createAudioEngine：对象 URL 生命周期', () => {
  it('加载本地文件会创建对象 URL', async () => {
    const { element, deps, created } = setup();
    const engine = createAudioEngine({}, deps);

    await engine.load({ path: 'a.flac', blob: blob() });

    expect(created).toEqual(['blob:track-1']);
    expect(element.src).toBe('blob:track-1');
    expect(engine.currentPath).toBe('a.flac');
  });

  it('切歌时 revoke 上一个对象 URL（否则内存只增不减）', async () => {
    const { deps, revoked } = setup();
    const engine = createAudioEngine({}, deps);

    await engine.load({ path: 'a.flac', blob: blob('a') });
    await engine.load({ path: 'b.mp3', blob: blob('b') });

    expect(revoked).toEqual(['blob:track-1']);
    expect(engine.currentPath).toBe('b.mp3');
  });

  it('dispose 会 revoke 当前对象 URL 并解绑事件', async () => {
    const { element, deps, revoked } = setup();
    const engine = createAudioEngine({}, deps);
    await engine.load({ path: 'a.flac', blob: blob() });

    engine.dispose();

    expect(revoked).toEqual(['blob:track-1']);
    expect(engine.currentPath).toBeUndefined();
    expect(element.listenerCount('timeupdate')).toBe(0);
    expect(element.listenerCount('ended')).toBe(0);
  });

  it('外部直链不会被 revoke（自己创建的才自己回收）', async () => {
    const { deps, revoked } = setup();
    const engine = createAudioEngine({}, deps);

    await engine.load({ path: 'a.flac', url: 'https://example.com/a.flac' });
    await engine.load({ path: 'b.flac', url: 'https://example.com/b.flac' });

    expect(revoked).toEqual([]);
  });
});

describe('createAudioEngine：事件与状态', () => {
  it('ended 事件转成 onEnded 回调', () => {
    const { element, deps } = setup();
    const onEnded = vi.fn();
    createAudioEngine({ onEnded }, deps);

    element.dispatch('ended');
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('timeupdate 回调带上位置与时长', () => {
    const { element, deps } = setup();
    const onTimeUpdate = vi.fn();
    createAudioEngine({ onTimeUpdate }, deps);

    element.currentTime = 12.5;
    element.duration = 200;
    element.dispatch('timeupdate');

    expect(onTimeUpdate).toHaveBeenCalledWith(12.5, 200);
  });

  it('play / pause 会汇报播放状态', async () => {
    const { element, deps } = setup();
    const onPlayStateChange = vi.fn();
    const engine = createAudioEngine({ onPlayStateChange }, deps);

    await engine.play();
    expect(onPlayStateChange).toHaveBeenLastCalledWith(true);

    engine.pause();
    expect(onPlayStateChange).toHaveBeenLastCalledWith(false);
    expect(element.paused).toBe(true);
  });

  it('autoplay 在 load 的同一个任务里就绪（否则会被自动播放策略拦下）', async () => {
    const { element, deps } = setup();
    const engine = createAudioEngine({}, deps);

    await engine.load({ path: 'a.flac', blob: blob(), autoplay: true });

    expect(element.playCalls).toBe(1);
    expect(element.paused).toBe(false);
  });

  it('恢复进度要等 loadedmetadata 才生效', async () => {
    const { element, deps } = setup();
    const engine = createAudioEngine({}, deps);

    await engine.load({ path: 'a.flac', blob: blob(), positionSec: 42 });
    expect(element.currentTime).toBe(0);

    element.duration = 200;
    element.dispatch('loadedmetadata');
    expect(element.currentTime).toBe(42);
  });

  it('播放失败不抛异常，转成 onError', async () => {
    const { element, deps } = setup();
    element.error = { message: '不支持的格式' };
    const onError = vi.fn();
    createAudioEngine({ onError }, deps);

    element.dispatch('error');
    expect(onError).toHaveBeenCalledWith('播放失败：不支持的格式');
  });

  it('play 被拒绝（自动播放策略）时转成 onError 而不是未捕获异常', async () => {
    const { element, deps } = setup();
    element.play = () => Promise.reject(new Error('NotAllowedError: play() failed'));
    const onError = vi.fn();
    const engine = createAudioEngine({ onError }, deps);

    await expect(engine.play()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('NotAllowedError: play() failed');
  });
});

describe('createAudioEngine：音量与跳转', () => {
  it('音量被夹在 0..1', () => {
    const { element, deps } = setup();
    const engine = createAudioEngine({}, deps);

    engine.setVolume(2);
    expect(element.volume).toBe(1);
    engine.setVolume(-1);
    expect(element.volume).toBe(0);
    engine.setVolume(0.35);
    expect(element.volume).toBeCloseTo(0.35, 5);
  });

  it('静音切换直接落到元素上', () => {
    const { element, deps } = setup();
    const engine = createAudioEngine({}, deps);

    engine.setMuted(true);
    expect(element.muted).toBe(true);
    engine.setMuted(false);
    expect(element.muted).toBe(false);
  });

  it('seek 不接受非法值，正常值直接落到元素上', () => {
    const { element, deps } = setup();
    const engine = createAudioEngine({}, deps);

    engine.seek(Number.NaN);
    expect(element.currentTime).toBe(0);

    engine.seek(30);
    expect(element.currentTime).toBe(30);

    engine.seek(-5);
    expect(element.currentTime).toBe(0);
  });

  it('toggle 在暂停与播放之间切换', async () => {
    const { element, deps } = setup();
    const engine = createAudioEngine({}, deps);

    await engine.toggle();
    expect(element.playCalls).toBe(1);

    await engine.toggle();
    expect(element.pauseCalls).toBe(1);
  });
});
