/**
 * 扫描之后把歌词文件认领到曲目上（技术方案 13 节）。
 *
 * 为什么单独一步而不是塞进 `scanLibrary`：两者的失效条件与清理规则完全不同——
 * 曲目缓存看"路径 + 大小 + 修改时间"，歌词还要看"用户的 .lrc 是否还在、是不是被手动改过"。
 * 分开之后这套规则可以用假来源 + 内存存储穷举测，不必牵扯元数据解析。
 *
 * 三条必须守住的规则：
 *  1. **用户导入/粘贴的歌词优先**：扫描不会覆盖它们
 *  2. **来源不支持歌词时什么都不做**：尤其不能把既有记录当成"用户删了 .lrc"清掉
 *  3. **清理只针对派生记录**：曲目没了 → 删；sidecar 对应的 .lrc 没了 → 删；导入/粘贴的不受影响
 */
import { matchLyrics } from '../core/lyricMatch.js';
import type { LyricTarget } from '../core/lyricMatch.js';
import { decodeLyrics } from '../core/lyrics.js';
import type { LyricDecoder } from '../core/lyrics.js';
import type { Track } from '../core/track.js';
import type { MusicSource } from './musicSource.js';
import type { LibraryStorage, LyricRecord } from './storage.js';

export interface LyricSyncStats {
  /** 新认领（原来没有歌词）。 */
  claimed: number;
  /** 重新读取（.lrc 内容变了）。 */
  updated: number;
  /** 用户导入/粘贴的，扫描不动它。 */
  kept: number;
  /** 已是最新，跳过读取。 */
  unchanged: number;
  /** 目录里有歌词但认不出对应哪首。 */
  unmatched: number;
  /** 有歧义（一歌多词 / 一词多歌），不自动认领。 */
  ambiguous: number;
  /** 清理掉的记录数。 */
  removed: number;
}

export interface LyricSyncOptions {
  storage: LibraryStorage;
  source: MusicSource;
  tracks: readonly Track[];
  now?: () => number;
  decode?: LyricDecoder;
  signal?: AbortSignal;
}

export async function syncLyrics(options: LyricSyncOptions): Promise<LyricSyncStats> {
  const { storage, source, tracks } = options;
  const now = options.now ?? (() => Date.now());
  const stats: LyricSyncStats = {
    claimed: 0,
    updated: 0,
    kept: 0,
    unchanged: 0,
    unmatched: 0,
    ambiguous: 0,
    removed: 0,
  };

  // 规则 2：来源不支持歌词就什么都不做（不能顺手清理）
  if (!source.listLyricFiles || !source.openLyricBytes) return stats;

  const lyricRefs = await source.listLyricFiles();
  const targets: LyricTarget[] = tracks.map((track) => ({
    path: track.path,
    name: track.name,
    title: track.title,
    artist: track.artist,
    album: track.album,
  }));

  const match = matchLyrics(targets, lyricRefs);
  stats.unmatched = match.unmatched.length;
  stats.ambiguous = match.ambiguous.length;

  const existing = new Map<string, LyricRecord>();
  for (const record of await storage.listLyrics()) existing.set(record.path, record);
  const refByPath = new Map(lyricRefs.map((ref) => [ref.path, ref]));

  const writes: LyricRecord[] = [];
  const claimedLyricPaths = new Set<string>();

  for (const assignment of match.assignments) {
    if (options.signal?.aborted) break;
    claimedLyricPaths.add(assignment.lyricPath);

    const current = existing.get(assignment.trackPath);
    // 规则 1：用户给的优先
    if (current && current.source !== 'sidecar') {
      stats.kept += 1;
      continue;
    }

    const ref = refByPath.get(assignment.lyricPath);
    if (!ref) continue;

    if (
      current &&
      current.lyricPath === ref.path &&
      current.lyricModifiedAt === ref.lastModified
    ) {
      stats.unchanged += 1;
      continue;
    }

    try {
      const text = decodeLyrics(await source.openLyricBytes(ref), options.decode);
      writes.push({
        path: assignment.trackPath,
        text,
        source: 'sidecar',
        lyricPath: ref.path,
        lyricModifiedAt: ref.lastModified,
        userOffsetSec: current?.userOffsetSec ?? 0,
        updatedAt: now(),
      });
      if (current) stats.updated += 1;
      else stats.claimed += 1;
    } catch {
      // 单个歌词读不出来不影响其它曲目，也不算认领成功
    }
  }

  await storage.putLyrics(writes);

  // 规则 3：清理派生记录
  const aliveTracks = new Set(tracks.map((track) => track.path));
  const dead: string[] = [];
  for (const record of existing.values()) {
    if (!aliveTracks.has(record.path)) {
      dead.push(record.path);
      continue;
    }
    if (record.source === 'sidecar' && record.lyricPath && !claimedLyricPaths.has(record.lyricPath)) {
      // 这个 .lrc 已经不在目录里了（被删或改名）
      dead.push(record.path);
    }
  }

  if (dead.length > 0) {
    await storage.deleteLyrics(dead);
    stats.removed = dead.length;
  }

  return stats;
}
