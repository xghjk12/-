/**
 * 播放状态节流写入的测试（技术方案 8.4）。
 *
 * 「进度每 5s 写一次 IndexedDB」这条约定如果只写在文档里，迟早会被改成"每次都写"，
 * 所以这里用假定时器把它固定住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './memoryStorage.js';
import { createStateWriter } from './stateWriter.js';
import type { PlaybackState } from './storage.js';

function state(positionSec: number, extra: Partial<PlaybackState> = {}): PlaybackState {
  return {
    volume: 0.8,
    muted: false,
    mode: 'sequence',
    trackPath: '专辑/a.flac',
    positionSec,
    updatedAt: 1_700_000_000_000,
    ...extra,
  };
}

describe('createStateWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('节流：多次 save 只在窗口末尾落一次盘，且写的是最后一次的值', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage);
    const spy = vi.spyOn(storage, 'writeState');

    writer.save(state(1));
    writer.save(state(2));
    writer.save(state(3));
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(spy).toHaveBeenCalledTimes(1);
    await expect(storage.readState()).resolves.toMatchObject({ positionSec: 3 });
  });

  it('第一个窗口结束后再 save 会开一个新窗口', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage);
    const spy = vi.spyOn(storage, 'writeState');

    writer.save(state(1));
    await vi.advanceTimersByTimeAsync(5000);
    writer.save(state(2));
    await vi.advanceTimersByTimeAsync(5000);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('saveNow 立即写入并取消待写的节流数据', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage);

    writer.save(state(1));
    await writer.saveNow(state(9, { volume: 0.2 }));

    expect(writer.pending).toBe(false);
    await expect(storage.readState()).resolves.toMatchObject({ volume: 0.2 });

    // 原来的定时器已经被取消，不应再写一次旧值
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(storage.readState()).resolves.toMatchObject({ volume: 0.2, positionSec: 9 });
  });

  it('flush 在暂停 / 切歌 / 页面隐藏时把待写内容立刻落盘', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage);

    writer.save(state(77));
    await writer.flush();

    expect(writer.pending).toBe(false);
    await expect(storage.readState()).resolves.toMatchObject({ positionSec: 77 });
  });

  it('没有待写内容时 flush 不写盘', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage);
    const spy = vi.spyOn(storage, 'writeState');

    await writer.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispose 丢掉待写内容并停掉定时器', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage);
    const spy = vi.spyOn(storage, 'writeState');

    writer.save(state(1));
    writer.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spy).not.toHaveBeenCalled();
    expect(writer.pending).toBe(false);
  });

  it('节流窗口可配置（测试与调参用）', async () => {
    const storage = memoryStorage();
    const writer = createStateWriter(storage, { throttleMs: 1000 });
    const spy = vi.spyOn(storage, 'writeState');

    writer.save(state(1));
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
