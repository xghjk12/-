/**
 * 增量扫描的行为锁定（技术方案 5.3）。
 *
 * 这套测试的价值在于：整套增量逻辑只依赖 `LibraryStorage` + `MusicSource` 两个接口，
 * 所以「缓存命中不碰文件」「只有变化的文件重新解析」「删除的文件连同缓存一起清」
 * 「取消时不能误删缓存」全部可以在 Node 里跑出来，不需要真浏览器。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../core/track.js';
import type { ByteSource } from './byteSource.js';
import type { TrackMetadata } from './metadata.js';
import { memoryStorage } from './memoryStorage.js';
import type { MusicSource } from './musicSource.js';
import { scanLibrary } from './scanner.js';

interface FakeEntry {
  path: string;
  size?: number;
  lastModified?: number;
}

interface FakeSource extends MusicSource {
  /** 实际被 open 过的路径，用来断言"命中缓存就不碰文件"。 */
  opened: string[];
}

function fakeSource(entries: FakeEntry[]): FakeSource {
  const opened: string[] = [];
  return {
    opened,
    rootName: '测试曲库',
    async listAudioFiles(onProgress) {
      const refs = entries.map((entry, index) => {
        onProgress?.(index + 1);
        return {
          path: entry.path,
          name: entry.path.split('/').pop() ?? entry.path,
          size: entry.size ?? 1024,
          lastModified: entry.lastModified ?? 1000,
        };
      });
      return refs;
    },
    async open(ref): Promise<ByteSource> {
      opened.push(ref.path);
      return { name: ref.name, size: ref.size, read: async () => new Uint8Array(0) };
    },
  };
}

function metadata(title: string, extra: Partial<TrackMetadata> = {}): TrackMetadata {
  return {
    title,
    titleFromFileName: false,
    durationSec: 200,
    readStrategy: 'probe',
    bytesRead: 1024,
    ...extra,
  };
}

/** 按文件名给出解析结果的假解析器。 */
function parser(map: Record<string, TrackMetadata>) {
  return async (source: ByteSource): Promise<TrackMetadata> => {
    const result = map[source.name];
    if (!result) throw new Error(`没有为 ${source.name} 准备解析结果`);
    return result;
  };
}

const NOW = 1_700_000_000_000;

describe('scanLibrary：首次扫描', () => {
  it('逐个解析并写入 files / tracks，顺序与列出顺序一致', async () => {
    const storage = memoryStorage();
    const source = fakeSource([
      { path: '专辑/01 第一首.flac' },
      { path: '专辑/02 第二首.mp3' },
    ]);

    const { tracks, stats } = await scanLibrary({
      storage,
      source,
      now: () => NOW,
      parse: parser({
        '01 第一首.flac': metadata('第一首'),
        '02 第二首.mp3': metadata('第二首'),
      }),
    });

    expect(source.opened).toEqual(['专辑/01 第一首.flac', '专辑/02 第二首.mp3']);
    expect(tracks.map((track) => track.title)).toEqual(['第一首', '第二首']);
    expect(tracks[0]?.path).toBe('专辑/01 第一首.flac');
    expect(stats).toMatchObject({ total: 2, parsed: 2, reused: 0, failed: 0, removed: 0 });
    expect(stats.bytesRead).toBe(2048);
    expect(storage.fileCount).toBe(2);
    expect(storage.trackCount).toBe(2);
  });

  it('封面单独存进 covers，曲目对象里只留 hasCover 标记', async () => {
    const storage = memoryStorage();
    const source = fakeSource([{ path: 'a.flac' }]);

    const { tracks } = await scanLibrary({
      storage,
      source,
      now: () => NOW,
      parse: parser({
        'a.flac': metadata('带封面', {
          cover: { mimeType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff]) },
        }),
      }),
    });

    expect(tracks[0]?.hasCover).toBe(true);
    expect(storage.coverCount).toBe(1);
    expect(storage.hasCover(tracks[0]!.cacheKey)).toBe(true);
    // 曲目记录里不该带封面字节
    expect(JSON.stringify(tracks[0])).not.toContain('255');
  });

  it('解析失败不中断扫描：坏文件入库并带上 parseError', async () => {
    const storage = memoryStorage();
    const source = fakeSource([{ path: 'broken.ape' }, { path: 'good.mp3' }]);

    const { tracks, stats } = await scanLibrary({
      storage,
      source,
      now: () => NOW,
      parse: parser({ 'good.mp3': metadata('好文件') }),
    });

    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.parseError).toBeTruthy();
    expect(tracks[0]?.title).toBe('broken');
    expect(tracks[1]?.title).toBe('好文件');
    expect(stats.failed).toBe(1);
  });

  it('parse 抛异常时同样不中断，且错误信息进 parseError', async () => {
    const storage = memoryStorage();
    const source = fakeSource([{ path: 'boom.mp3' }, { path: 'good.mp3' }]);

    const { tracks } = await scanLibrary({
      storage,
      source,
      now: () => NOW,
      parse: async (byteSource) => {
        if (byteSource.name === 'boom.mp3') throw new Error('磁盘炸了');
        return metadata('好文件');
      },
    });

    expect(tracks[0]?.parseError).toBe('磁盘炸了');
    expect(tracks[1]?.title).toBe('好文件');
  });
});

describe('scanLibrary：增量', () => {
  it('二次扫描全命中，完全不打开文件', async () => {
    const storage = memoryStorage();
    const entries = [{ path: 'a.flac' }, { path: 'b.mp3' }];
    const parse = parser({ 'a.flac': metadata('A'), 'b.mp3': metadata('B') });

    const first = await scanLibrary({ storage, source: fakeSource(entries), now: () => NOW, parse });

    const secondSource = fakeSource(entries);
    const second = await scanLibrary({
      storage,
      source: secondSource,
      now: () => NOW,
      parse,
    });

    expect(secondSource.opened).toEqual([]);
    expect(second.stats).toMatchObject({ parsed: 0, reused: 2, bytesRead: 0, removed: 0 });
    expect(second.tracks.map((track) => track.path)).toEqual(
      first.tracks.map((track) => track.path),
    );
  });

  it('只有变化的文件重新解析（大小或修改时间变化）', async () => {
    const storage = memoryStorage();
    const parse = parser({ 'a.flac': metadata('A'), 'b.mp3': metadata('B') });
    await scanLibrary({
      storage,
      source: fakeSource([{ path: 'a.flac' }, { path: 'b.mp3', lastModified: 1000 }]),
      now: () => NOW,
      parse,
    });

    const changed = fakeSource([
      { path: 'a.flac' },
      { path: 'b.mp3', lastModified: 2000 },
    ]);
    const result = await scanLibrary({ storage, source: changed, now: () => NOW, parse });

    expect(changed.opened).toEqual(['b.mp3']);
    expect(result.stats).toMatchObject({ parsed: 1, reused: 1 });
  });

  it('新增文件只解析新增的那首', async () => {
    const storage = memoryStorage();
    const parse = parser({
      'a.flac': metadata('A'),
      'new.mp3': metadata('新歌'),
    });
    await scanLibrary({ storage, source: fakeSource([{ path: 'a.flac' }]), now: () => NOW, parse });

    const grown = fakeSource([{ path: 'a.flac' }, { path: 'new.mp3' }]);
    const result = await scanLibrary({ storage, source: grown, now: () => NOW, parse });

    expect(grown.opened).toEqual(['new.mp3']);
    expect(result.tracks.map((track) => track.title)).toEqual(['A', '新歌']);
    expect(result.stats).toMatchObject({ parsed: 1, reused: 1 });
  });

  it('删除文件时连同它的 tracks / covers 一起清理', async () => {
    const storage = memoryStorage();
    const parse = parser({
      'a.flac': metadata('A', {
        cover: { mimeType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) },
      }),
      'b.mp3': metadata('B'),
    });
    const first = await scanLibrary({
      storage,
      source: fakeSource([{ path: 'a.flac' }, { path: 'b.mp3' }]),
      now: () => NOW,
      parse,
    });
    const removedKey = first.tracks[0]!.cacheKey;
    expect(storage.coverCount).toBe(1);

    const shrunk = fakeSource([{ path: 'b.mp3' }]);
    const result = await scanLibrary({
      storage,
      source: shrunk,
      now: () => NOW,
      parse,
    });

    expect(result.stats.removed).toBe(1);
    expect(storage.fileCount).toBe(1);
    expect(storage.trackCount).toBe(1);
    expect(storage.coverCount).toBe(0);
    await expect(storage.getTrack(removedKey)).resolves.toBeUndefined();
  });

  it('清理没有 files 引用的孤儿缓存', async () => {
    const orphan: Track = {
      path: '幽灵.mp3',
      name: '幽灵.mp3',
      size: 10,
      lastModified: 1,
      cacheKey: '幽灵.mp3\u000010\u00001',
      title: '幽灵',
      titleFromFileName: false,
      extension: 'mp3',
      verdict: 'decodable',
      hasCover: true,
      addedAt: NOW,
    };
    const storage = memoryStorage({
      tracks: [orphan],
      covers: [{ cacheKey: orphan.cacheKey, cover: { mimeType: 'image/jpeg', data: new Blob() } }],
    });

    await scanLibrary({
      storage,
      source: fakeSource([{ path: 'a.flac' }]),
      now: () => NOW,
      parse: parser({ 'a.flac': metadata('A') }),
    });

    expect(storage.trackCount).toBe(1);
    expect(storage.coverCount).toBe(0);
    await expect(storage.getTrack(orphan.cacheKey)).resolves.toBeUndefined();
  });
});

describe('scanLibrary：取消', () => {
  it('取消后保留已解析的成果，且绝不清理已有缓存', async () => {
    const storage = memoryStorage();
    const controller = new AbortController();

    const { tracks, stats } = await scanLibrary({
      storage,
      source: fakeSource([{ path: 'a.flac' }, { path: 'b.mp3' }, { path: 'c.mp3' }]),
      signal: controller.signal,
      now: () => NOW,
      parse: async (byteSource) => {
        controller.abort();
        return metadata(byteSource.name);
      },
    });

    expect(stats.aborted).toBe(true);
    // 只处理了第一首，但它是有效的缓存条目，必须落库
    expect(tracks).toHaveLength(1);
    expect(storage.fileCount).toBe(1);
    expect(storage.trackCount).toBe(1);
    expect(stats.removed).toBe(0);
  });

  it('取消不会误删"这次没出现"的旧记录', async () => {
    const storage = memoryStorage();
    const parse = parser({
      'a.mp3': metadata('A'),
      'z.mp3': metadata('Z'),
      'new.mp3': metadata('新歌'),
    });
    await scanLibrary({
      storage,
      source: fakeSource([{ path: 'a.mp3' }, { path: 'z.mp3' }]),
      now: () => NOW,
      parse,
    });
    expect((await storage.listFiles()).length).toBe(2);

    // 第二次扫描：a.mp3 命中缓存，new.mp3 是新的（解析时触发取消），z.mp3 还没轮到
    const controller = new AbortController();
    const second = fakeSource([{ path: 'a.mp3' }, { path: 'new.mp3' }, { path: 'z.mp3' }]);
    const result = await scanLibrary({
      storage,
      source: second,
      signal: controller.signal,
      now: () => NOW,
      parse: async (byteSource) => {
        controller.abort();
        return parse(byteSource);
      },
    });

    expect(result.stats.aborted).toBe(true);
    expect(second.opened).toEqual(['new.mp3']);
    // z.mp3 只是"没轮到"，绝不是"被删了"
    const paths = (await storage.listFiles()).map((file) => file.path).sort();
    expect(paths).toEqual(['a.mp3', 'new.mp3', 'z.mp3']);
    expect(result.stats.removed).toBe(0);
  });
});

describe('scanLibrary：进度与分片', () => {
  it('按 listing → parsing → done 汇报进度与计数', async () => {
    const phases: string[] = [];
    const onProgress = vi.fn((progress: { phase: string; total: number; found: number }) => {
      if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
    });

    await scanLibrary({
      storage: memoryStorage(),
      source: fakeSource([{ path: 'a.mp3' }, { path: 'b.mp3' }, { path: 'c.mp3' }]),
      onProgress,
      batchSize: 2,
      now: () => NOW,
      parse: parser({
        'a.mp3': metadata('A'),
        'b.mp3': metadata('B'),
        'c.mp3': metadata('C'),
      }),
    });

    expect(phases).toEqual(['listing', 'parsing', 'done']);
    const last = onProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ phase: 'done', found: 3, total: 3, parsed: 3, reused: 0 });
  });

  it('分片扫描时每批让出事件循环（batchSize 生效）', async () => {
    const visited: string[] = [];
    await scanLibrary({
      storage: memoryStorage(),
      source: fakeSource([{ path: 'a.mp3' }, { path: 'b.mp3' }]),
      batchSize: 1,
      now: () => NOW,
      parse: async (byteSource) => {
        visited.push(byteSource.name);
        return metadata(byteSource.name);
      },
    });
    expect(visited).toEqual(['a.mp3', 'b.mp3']);
  });

  it('空目录不报错，统计全为 0', async () => {
    const { tracks, stats } = await scanLibrary({
      storage: memoryStorage(),
      source: fakeSource([]),
      now: () => NOW,
      parse: parser({}),
    });
    expect(tracks).toEqual([]);
    expect(stats).toMatchObject({ total: 0, parsed: 0, reused: 0, removed: 0, aborted: false });
  });
});
