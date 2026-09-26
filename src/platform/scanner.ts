/**
 * 增量扫描（技术方案 5.3）。
 *
 * 对每个文件：
 *  - 命中（路径 + 大小 + 修改时间全等，且元数据缓存还在）→ 直接复用，完全不碰文件
 *  - 未命中 → 解析元数据、写 tracks / covers、更新 files 记录
 *
 * 扫描结束后还要做两步清理，这两步最容易被忽略，不做的话缓存只增不减：
 *  - `files` 里存在但本次没出现的路径 → 文件已删除或改名，连同它的 tracks / covers 一起删
 *  - 没有任何 `files` 引用的 tracks / covers → 孤儿，一并删
 *
 * **取消时不能做清理**：已经列出的文件不完整，"没出现"并不代表"被删了"，
 * 照常清理会把整个缓存误删。所以取消只保留已解析的成果。
 *
 * 这里只依赖 `LibraryStorage` 与 `MusicSource` 两个接口，因此整套增量逻辑
 * 可以在 Node 里用 `memoryStorage()` + 假 MusicSource 完整测出来。
 */
import { guessTitle, isCacheHit } from '../core/library.js';
import type { Track } from '../core/track.js';
import type { ByteSource } from './byteSource.js';
import { readMetadata } from './metadata.js';
import type { TrackMetadata } from './metadata.js';
import type { AudioFileRef, MusicSource } from './musicSource.js';
import type { CoverRecord, LibraryStorage, StoredFile } from './storage.js';
import { buildTrack } from './trackBuilder.js';

export interface ScanProgress {
  phase: 'listing' | 'parsing' | 'done' | 'aborted';
  /** 已发现的音频文件数（listing 阶段在增长）。 */
  found: number;
  /** 已知的待处理总数；listing 阶段还为 0。 */
  total: number;
  /** 已解析（未命中缓存）的数量。 */
  parsed: number;
  /** 直接命中缓存的数量。 */
  reused: number;
  /** 解析失败（但已入库）的数量。 */
  failed: number;
  /** 正在处理的文件路径。 */
  currentPath?: string;
}

export interface ScanStats {
  total: number;
  parsed: number;
  reused: number;
  failed: number;
  /** 清理掉的、已经不在磁盘上的文件数。 */
  removed: number;
  /** 实际读取的字节数——这个数字是「只读文件头」收益的直接证据。 */
  bytesRead: number;
  elapsedMs: number;
  aborted: boolean;
}

export interface ScanResult {
  tracks: Track[];
  stats: ScanStats;
}

export interface ScanOptions {
  storage: LibraryStorage;
  source: MusicSource;
  onProgress?: (progress: ScanProgress) => void;
  /** 取消信号：扫描可中断，已解析的成果保留。 */
  signal?: AbortSignal;
  /** 每处理多少首让出一次事件循环并把结果落库。 */
  batchSize?: number;
  /** 注入解析实现，测试用它绕开真实文件。 */
  parse?: (source: ByteSource) => Promise<TrackMetadata>;
  now?: () => number;
}

/** 让出事件循环：I/O 是异步的，真正需要的是别让一整轮扫描独占主线程（技术方案 6.1）。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function coverRecord(metadata: TrackMetadata): CoverRecord | undefined {
  if (!metadata.cover) return undefined;
  const { mimeType, data } = metadata.cover;
  return { mimeType, data: new Blob([data as BlobPart], { type: mimeType }) };
}

export async function scanLibrary(options: ScanOptions): Promise<ScanResult> {
  const { storage, source, signal } = options;
  const onProgress = options.onProgress ?? (() => {});
  const parse = options.parse ?? readMetadata;
  const now = options.now ?? (() => Date.now());
  const batchSize = Math.max(1, options.batchSize ?? 25);
  const startedAt = now();

  const previousFiles = new Map<string, StoredFile>();
  for (const file of await storage.listFiles()) previousFiles.set(file.path, file);

  // 先整体读出来，命中时不必逐条 getTrack
  const cachedTracks = new Map<string, Track>();
  for (const track of await storage.listTracks()) cachedTracks.set(track.cacheKey, track);

  const state = {
    found: 0,
    parsed: 0,
    reused: 0,
    failed: 0,
  };

  const listed = await source.listAudioFiles((found) => {
    state.found = found;
    onProgress({ phase: 'listing', ...state, total: 0 });
  });

  const aborted = () => signal?.aborted ?? false;
  const tracks: Track[] = [];
  const seen = new Set<string>();
  const pendingFiles: StoredFile[] = [];
  const pendingTracks: Track[] = [];
  const pendingCovers: Array<{ cacheKey: string; cover: CoverRecord }> = [];
  let bytesRead = 0;

  const progress = (phase: ScanProgress['phase'], currentPath?: string): void => {
    onProgress({ phase, ...state, total: listed.length, currentPath });
  };

  const flush = async (): Promise<void> => {
    if (pendingTracks.length > 0) {
      await storage.putTracks(pendingTracks.splice(0, pendingTracks.length));
    }
    if (pendingCovers.length > 0) {
      await storage.putCovers(pendingCovers.splice(0, pendingCovers.length));
    }
    if (pendingFiles.length > 0) {
      await storage.putFiles(pendingFiles.splice(0, pendingFiles.length));
    }
  };

  let wasAborted = false;

  for (const [index, ref] of listed.entries()) {
    if (aborted()) {
      wasAborted = true;
      break;
    }

    seen.add(ref.path);
    const identity: AudioFileRef = ref;
    const previous = previousFiles.get(ref.path);
    const cached = previous ? cachedTracks.get(previous.cacheKey) : undefined;

    if (cached && isCacheHit(previous, identity)) {
      tracks.push(cached);
      state.reused += 1;
    } else {
      let metadata: TrackMetadata;
      try {
        metadata = await parse(await source.open(ref));
      } catch (error) {
        // 解析层承诺不抛异常，这里再兜一层：一个坏文件绝不能让整次扫描中断
        metadata = {
          title: guessTitle(ref.name),
          titleFromFileName: true,
          readStrategy: 'probe',
          bytesRead: 0,
          parseError: error instanceof Error ? error.message : String(error),
        };
      }

      bytesRead += metadata.bytesRead;
      if (metadata.parseError) state.failed += 1;

      const track = buildTrack(ref, metadata, now());
      tracks.push(track);
      pendingTracks.push(track);
      pendingFiles.push({ ...identity, cacheKey: track.cacheKey });
      const cover = coverRecord(metadata);
      if (cover) pendingCovers.push({ cacheKey: track.cacheKey, cover });
      state.parsed += 1;
    }

    if ((index + 1) % batchSize === 0) {
      await flush();
      await yieldToEventLoop();
      progress('parsing', ref.path);
    }
  }

  // 取消时也要把已解析的成果落库：它们是有效的缓存条目
  await flush();

  const stats: ScanStats = {
    total: listed.length,
    parsed: state.parsed,
    reused: state.reused,
    failed: state.failed,
    removed: 0,
    bytesRead,
    elapsedMs: now() - startedAt,
    aborted: wasAborted,
  };

  if (wasAborted) {
    progress('aborted');
    return { tracks, stats };
  }

  // ---- 清理：先删「不在磁盘上」的，再删「没有 files 引用」的孤儿 ----
  const stalePaths = [...previousFiles.keys()].filter((path) => !seen.has(path));
  const staleKeys = stalePaths.map((path) => previousFiles.get(path)!.cacheKey);

  const liveKeys = new Set(tracks.map((track) => track.cacheKey));
  const orphanKeys = [...cachedTracks.keys()].filter((cacheKey) => !liveKeys.has(cacheKey));

  const deadKeys = [...new Set([...staleKeys, ...orphanKeys])];
  if (stalePaths.length > 0) await storage.deleteFiles(stalePaths);
  if (deadKeys.length > 0) {
    await storage.deleteTracks(deadKeys);
    await storage.deleteCovers(deadKeys);
  }
  stats.removed = stalePaths.length;

  progress('done');
  return { tracks, stats };
}
