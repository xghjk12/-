/**
 * 把「文件引用 + 解析结果」映射成界面用的 `Track`。
 *
 * 独立成文件是因为这段映射有两个容易写错的地方，值得单独测：
 *  1. 播放判定要复核 codec（`.m4a` 里可能装的是 ALAC），不能只看扩展名
 *  2. `cacheKey` 必须用「路径 + 大小 + 修改时间」，而 `path` 是曲目身份，两者不能混
 */
import { classifyAudioFile, extensionOf, resolveVerdict } from '../core/audioFormats.js';
import { cacheKey as makeCacheKey } from '../core/library.js';
import { buildSearchKey } from '../core/sort.js';
import type { Track } from '../core/track.js';
import type { TrackMetadata } from './metadata.js';
import type { AudioFileRef } from './musicSource.js';

/** 理论上扫描阶段已经按扩展名筛过，这里只是兜底，避免 undefined 传进界面。 */
const UNKNOWN_FORMAT_NOTE = '无法识别的音频格式，只能查看文件信息';

export function buildTrack(ref: AudioFileRef, metadata: TrackMetadata, addedAt: number): Track {
  const format = classifyAudioFile(ref.name);
  const verdict = format
    ? resolveVerdict(format, metadata.codec)
    : { verdict: 'metadata-only' as const, note: UNKNOWN_FORMAT_NOTE };

  return {
    path: ref.path,
    name: ref.name,
    size: ref.size,
    lastModified: ref.lastModified,
    cacheKey: makeCacheKey(ref),

    title: metadata.title,
    titleFromFileName: metadata.titleFromFileName,
    artist: metadata.artist,
    album: metadata.album,
    albumArtist: metadata.albumArtist,
    year: metadata.year,
    trackNo: metadata.trackNo,
    durationSec: metadata.durationSec,

    extension: format?.extension ?? extensionOf(ref.name),
    codec: metadata.codec,
    container: metadata.container,
    lossless: metadata.lossless,
    bitrate: metadata.bitrate,
    sampleRate: metadata.sampleRate,

    // 入库时就把检索键算好：搜索是逐键触发的，不能每次现算拼音
    searchKey: buildSearchKey({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
    }),

    verdict: verdict.verdict,
    verdictNote: verdict.note,

    hasCover: Boolean(metadata.cover),
    parseError: metadata.parseError,
    addedAt,
  };
}

/** 从已缓存的曲目判断缓存是否仍然有效（增量扫描的命中条件）。 */
export function fileFromTrack(track: Track): {
  path: string;
  size: number;
  lastModified: number;
  cacheKey: string;
} {
  return {
    path: track.path,
    size: track.size,
    lastModified: track.lastModified,
    cacheKey: track.cacheKey,
  };
}
