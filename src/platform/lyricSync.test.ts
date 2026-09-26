/**
 * 歌词同步的测试（`syncLyrics`）。
 *
 * 这套逻辑的价值全在那三条规则上，所以用例也围着它们转：
 *  1. 用户导入/粘贴的歌词不会被扫描覆盖
 *  2. 来源不支持歌词时什么都不做——**尤其不能把既有记录清掉**
 *  3. 清理只针对派生记录（曲目没了、.lrc 没了）
 */
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../core/track.js';
import { memoryStorage } from './memoryStorage.js';
import type { LyricRecord } from './storage.js';
import { syncLyrics } from './lyricSync.js';
import type { LyricFileRef, MusicSource } from './musicSource.js';

function track(path: string, overrides: Partial<Track> = {}): Track {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1024,
    lastModified: 1,
    cacheKey: `${path}\u00001024\u00001`,
    title: '青花瓷',
    titleFromFileName: false,
    durationSec: 200,
    extension: 'flac',
    verdict: 'decodable',
    hasCover: false,
    addedAt: 1000,
    ...overrides,
  };
}

interface FakeLyric {
  path: string;
  text: string;
  lastModified?: number;
}

function fakeSource(lyrics: FakeLyric[], options: { withLyrics?: boolean } = {}): MusicSource & {
  reads: string[];
} {
  const reads: string[] = [];
  const base: MusicSource = {
    rootName: '测试曲库',
    async listAudioFiles() {
      return [];
    },
    async open() {
      throw new Error('不该读音频');
    },
  };

  if (options.withLyrics === false) return Object.assign(base, { reads });

  return Object.assign(base, {
    reads,
    async listLyricFiles(): Promise<LyricFileRef[]> {
      return lyrics.map((item) => ({
        path: item.path,
        name: item.path.split('/').pop() ?? item.path,
        size: item.text.length,
        lastModified: item.lastModified ?? 1000,
      }));
    },
    async openLyricBytes(ref: LyricFileRef) {
      const found = lyrics.find((item) => item.path === ref.path);
      if (!found) throw new Error(`找不到歌词：${ref.path}`);
      reads.push(ref.path);
      return new TextEncoder().encode(found.text);
    },
  });
}

const NOW = 1_700_000_000_000;

describe('syncLyrics：认领', () => {
  it('同目录同名歌词被认领，写入解码后的文本', async () => {
    const storage = memoryStorage();
    const source = fakeSource([{ path: '专辑/青花瓷.lrc', text: '[00:01.00]素胚勾勒出青花' }]);

    const stats = await syncLyrics({
      storage,
      source,
      tracks: [track('专辑/青花瓷.flac')],
      now: () => NOW,
    });

    expect(stats).toMatchObject({ claimed: 1, updated: 0, kept: 0, unchanged: 0 });
    const record = await storage.getLyrics('专辑/青花瓷.flac');
    expect(record).toMatchObject({
      source: 'sidecar',
      lyricPath: '专辑/青花瓷.lrc',
      lyricModifiedAt: 1000,
      userOffsetSec: 0,
      updatedAt: NOW,
    });
    expect(record?.text).toContain('素胚勾勒出青花');
  });

  it('内容没变时跳过读取（不重复读文件）', async () => {
    const storage = memoryStorage();
    const lyrics = [{ path: '专辑/青花瓷.lrc', text: '[00:01.00]词' }];
    const first = fakeSource(lyrics);
    await syncLyrics({ storage, source: first, tracks: [track('专辑/青花瓷.flac')], now: () => NOW });

    const second = fakeSource(lyrics);
    const stats = await syncLyrics({
      storage,
      source: second,
      tracks: [track('专辑/青花瓷.flac')],
      now: () => NOW,
    });

    expect(stats.unchanged).toBe(1);
    expect(second.reads).toEqual([]);
  });

  it('.lrc 修改时间变了会重读', async () => {
    const storage = memoryStorage();
    await syncLyrics({
      storage,
      source: fakeSource([{ path: '专辑/青花瓷.lrc', text: '旧歌词' }]),
      tracks: [track('专辑/青花瓷.flac')],
      now: () => NOW,
    });

    const stats = await syncLyrics({
      storage,
      source: fakeSource([{ path: '专辑/青花瓷.lrc', text: '新歌词', lastModified: 2000 }]),
      tracks: [track('专辑/青花瓷.flac')],
      now: () => NOW,
    });

    expect(stats).toMatchObject({ updated: 1, claimed: 0 });
    expect((await storage.getLyrics('专辑/青花瓷.flac'))?.text).toBe('新歌词');
  });

  it('重读时保留用户微调的偏移', async () => {
    const storage = memoryStorage();
    const userRecord: LyricRecord = {
      path: '专辑/青花瓷.flac',
      text: '旧',
      source: 'sidecar',
      lyricPath: '专辑/青花瓷.lrc',
      lyricModifiedAt: 500,
      userOffsetSec: 0.5,
      updatedAt: NOW,
    };
    await storage.putLyrics([userRecord]);

    await syncLyrics({
      storage,
      source: fakeSource([{ path: '专辑/青花瓷.lrc', text: '新' }]),
      tracks: [track('专辑/青花瓷.flac')],
      now: () => NOW,
    });

    expect((await storage.getLyrics('专辑/青花瓷.flac'))?.userOffsetSec).toBe(0.5);
  });

  it('中文 GBK 歌词照样认领（编码回退在 core 里）', async () => {
    const storage = memoryStorage();
    const gbkBytes = new Uint8Array([0xc7, 0xe0, 0xbb, 0xa8, 0xb4, 0xc9]);
    const source: MusicSource = {
      rootName: '测试',
      async listAudioFiles() {
        return [];
      },
      async open() {
        throw new Error('不该读音频');
      },
      async listLyricFiles() {
        return [{ path: 'a.lrc', name: 'a.lrc', size: gbkBytes.length, lastModified: 1 }];
      },
      async openLyricBytes() {
        return gbkBytes;
      },
    };

    await syncLyrics({ storage, source, tracks: [track('a.flac', { title: 'a' })], now: () => NOW });

    expect((await storage.getLyrics('a.flac'))?.text).toBe('青花瓷');
  });
});

describe('syncLyrics：用户的歌词优先', () => {
  it('导入/粘贴的歌词不会被同名的 .lrc 覆盖', async () => {
    const storage = memoryStorage();
    await storage.putLyrics([
      {
        path: '专辑/青花瓷.flac',
        text: '我手动导入的歌词',
        source: 'import',
        userOffsetSec: 0,
        updatedAt: NOW,
      },
    ]);

    const source = fakeSource([{ path: '专辑/青花瓷.lrc', text: '文件夹里的歌词' }]);
    const stats = await syncLyrics({ storage, source, tracks: [track('专辑/青花瓷.flac')], now: () => NOW });

    expect(stats).toMatchObject({ kept: 1, claimed: 0, updated: 0 });
    expect((await storage.getLyrics('专辑/青花瓷.flac'))?.text).toBe('我手动导入的歌词');
    expect(source.reads).toEqual([]);
  });

  it('清理时不会删掉导入的歌词（即使目录里没有同名 .lrc）', async () => {
    const storage = memoryStorage();
    await storage.putLyrics([
      { path: 'a.flac', text: '粘贴的', source: 'paste', userOffsetSec: 0, updatedAt: NOW },
    ]);

    const stats = await syncLyrics({
      storage,
      source: fakeSource([]),
      tracks: [track('a.flac', { title: 'a' })],
      now: () => NOW,
    });

    expect(stats.removed).toBe(0);
    expect(storage.getLyricsText('a.flac')).toBe('粘贴的');
  });
});

describe('syncLyrics：清理', () => {
  it('曲目从曲库里消失时删掉它的歌词', async () => {
    const storage = memoryStorage();
    await storage.putLyrics([
      { path: 'old.flac', text: '旧歌歌词', source: 'import', userOffsetSec: 0, updatedAt: NOW },
    ]);

    const stats = await syncLyrics({
      storage,
      source: fakeSource([]),
      tracks: [track('new.flac', { title: 'new' })],
      now: () => NOW,
    });

    expect(stats.removed).toBe(1);
    expect(storage.lyricCount).toBe(0);
  });

  it('.lrc 被删掉时清掉对应的 sidecar 记录', async () => {
    const storage = memoryStorage();
    await syncLyrics({
      storage,
      source: fakeSource([{ path: '专辑/a.lrc', text: '歌词' }]),
      tracks: [track('专辑/a.flac', { title: 'a' })],
      now: () => NOW,
    });
    expect(storage.lyricCount).toBe(1);

    const stats = await syncLyrics({
      storage,
      source: fakeSource([]),
      tracks: [track('专辑/a.flac', { title: 'a' })],
      now: () => NOW,
    });

    expect(stats.removed).toBe(1);
    expect(storage.lyricCount).toBe(0);
  });

  it('来源不支持歌词时什么都不做，也不清空既有记录（关键）', async () => {
    const storage = memoryStorage();
    await storage.putLyrics([
      { path: 'a.flac', text: '已有歌词', source: 'sidecar', lyricPath: 'a.lrc', userOffsetSec: 0, updatedAt: NOW },
    ]);

    const stats = await syncLyrics({
      storage,
      source: fakeSource([], { withLyrics: false }),
      tracks: [track('a.flac', { title: 'a' })],
      now: () => NOW,
    });

    expect(stats).toEqual({
      claimed: 0,
      updated: 0,
      kept: 0,
      unchanged: 0,
      unmatched: 0,
      ambiguous: 0,
      removed: 0,
    });
    expect(storage.lyricCount).toBe(1);
  });
});

describe('syncLyrics：歧义与容错', () => {
  it('有歧义时不认领，并统计数量', async () => {
    const storage = memoryStorage();
    const source = fakeSource([{ path: '相册/sample-cn.lrc', text: '歌词' }]);

    const stats = await syncLyrics({
      storage,
      source,
      tracks: [
        track('相册/sample-cn.flac', { name: 'sample-cn.flac' }),
        track('相册/sample-cn.mp3', { name: 'sample-cn.mp3' }),
      ],
      now: () => NOW,
    });

    expect(stats).toMatchObject({ ambiguous: 1, claimed: 0 });
    expect(storage.lyricCount).toBe(0);
  });

  it('认不出来的歌词计入 unmatched', async () => {
    const stats = await syncLyrics({
      storage: memoryStorage(),
      source: fakeSource([{ path: '专辑/完全无关.lrc', text: 'x' }]),
      tracks: [track('专辑/a.flac', { title: 'a' })],
      now: () => NOW,
    });

    expect(stats).toMatchObject({ unmatched: 1, claimed: 0 });
  });

  it('单个歌词读失败不影响其它曲目', async () => {
    const storage = memoryStorage();
    const source: MusicSource = {
      rootName: '测试',
      async listAudioFiles() {
        return [];
      },
      async open() {
        throw new Error('不该读音频');
      },
      async listLyricFiles() {
        return [
          { path: 'a.lrc', name: 'a.lrc', size: 1, lastModified: 1 },
          { path: 'b.lrc', name: 'b.lrc', size: 1, lastModified: 1 },
        ];
      },
      async openLyricBytes(ref) {
        if (ref.path === 'a.lrc') throw new Error('读失败');
        return new TextEncoder().encode('b 的歌词');
      },
    };

    const stats = await syncLyrics({
      storage,
      source,
      tracks: [track('a.flac', { title: 'a' }), track('b.flac', { title: 'b' })],
      now: () => NOW,
    });

    expect(stats.claimed).toBe(1);
    expect(storage.getLyricsText('b.flac')).toBe('b 的歌词');
    expect(await storage.getLyrics('a.flac')).toBeUndefined();
  });

  it('取消后不再继续写（保留已处理的成果）', async () => {
    const storage = memoryStorage();
    const controller = new AbortController();
    const source = fakeSource([
      { path: 'a.lrc', text: 'a' },
      { path: 'b.lrc', text: 'b' },
    ]);
    const spy = vi.spyOn(storage, 'putLyrics');

    controller.abort();
    const stats = await syncLyrics({
      storage,
      source,
      tracks: [track('a.flac', { title: 'a' }), track('b.flac', { title: 'b' })],
      signal: controller.signal,
      now: () => NOW,
    });

    expect(stats.claimed).toBe(0);
    // 取消时仍会调用一次（写空数组），但不会有任何记录
    expect(spy).toHaveBeenCalled();
    expect(storage.lyricCount).toBe(0);
  });
});
