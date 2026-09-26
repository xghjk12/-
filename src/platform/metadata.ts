/**
 * 元数据解析。M0 已用真实 flac / mp3 验证过这条路径。
 *
 * 读取策略分两级，目的是别把整个文件读进来：
 *  1. 先读文件头（默认 512KB）。FLAC 的 STREAMINFO + Vorbis comment、MP3 的 ID3v2
 *     都在文件开头，实测 1KB 就足够读出标题、艺术家与封面。
 *  2. 只有当头部读不出任何标题/艺术家/专辑时，才回退读整个文件——这是为了兜住
 *     标签只写在文件尾部的情况（典型是只有 ID3v1 的老 mp3）。
 *
 * 解析失败不抛异常，而是把原因放进 `parseError` 并回退到文件名标题，避免一个坏文件
 * 中断整次扫描。
 */
import { parseBuffer, selectCover } from 'music-metadata';
import { guessTitle } from '../core/library.js';
import type { ByteSource } from './byteSource.js';

/** 默认只读的头部字节数。1KB 实测已够用，留 512KB 是为体积较大的内嵌封面留余量。 */
export const DEFAULT_HEAD_BYTES = 512 * 1024;

export interface CoverImage {
  mimeType: string;
  data: Uint8Array;
}

export interface TrackMetadata {
  title: string;
  /** 标题来自文件名回退（没有可用的标题标签）时为 true。 */
  titleFromFileName: boolean;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNo?: number;
  durationSec?: number;
  codec?: string;
  container?: string;
  lossless?: boolean;
  bitrate?: number;
  sampleRate?: number;
  cover?: CoverImage;
  /** 实际采用的读取策略，用于在扫描进度里解释代价。 */
  readStrategy: 'head' | 'full';
  /** 实际读取的字节数，测试用它锁住"头部够用就不读整文件"。 */
  bytesRead: number;
  /** 解析失败的原因；成功时为 undefined。 */
  parseError?: string;
}

type ParsedMetadata = Awaited<ReturnType<typeof parseBuffer>>;

type ParseOutcome =
  | { ok: true; metadata: ParsedMetadata }
  | { ok: false; error: Error };

async function parseBytes(bytes: Uint8Array, totalSize: number): Promise<ParseOutcome> {
  try {
    return { ok: true, metadata: await parseBuffer(bytes, { size: totalSize }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 头部是否已经读到足够的信息，不必再读整个文件。 */
function headIsEnough(outcome: ParseOutcome): boolean {
  if (!outcome.ok) return false;
  const { title, artist, album } = outcome.metadata.common;
  return Boolean(title || artist || album);
}

function buildResult(
  outcome: ParseOutcome,
  source: ByteSource,
  readStrategy: 'head' | 'full',
  bytesRead: number,
): TrackMetadata {
  const fallbackTitle = guessTitle(source.name);
  const base = {
    title: fallbackTitle,
    titleFromFileName: true,
    readStrategy,
    bytesRead,
  } satisfies TrackMetadata;

  if (!outcome.ok) {
    return { ...base, parseError: outcome.error.message };
  }

  const { common, format } = outcome.metadata;
  const picture = selectCover(common.picture);

  return {
    title: common.title ?? fallbackTitle,
    titleFromFileName: !common.title,
    artist: common.artist,
    album: common.album,
    albumArtist: common.albumartist,
    year: common.year,
    trackNo: common.track?.no ?? undefined,
    durationSec: format.duration,
    codec: format.codec,
    container: format.container,
    lossless: format.lossless,
    bitrate: format.bitrate,
    sampleRate: format.sampleRate,
    cover: picture ? { mimeType: picture.format, data: new Uint8Array(picture.data) } : undefined,
    readStrategy,
    bytesRead,
  };
}

export interface ReadMetadataOptions {
  /** 覆盖默认头部读取长度，测试用它构造"头部不够"的场景。 */
  headBytes?: number;
}

export async function readMetadata(
  source: ByteSource,
  options: ReadMetadataOptions = {},
): Promise<TrackMetadata> {
  const headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES;
  const headLimit = Math.min(headBytes, source.size);

  const head = await source.read(0, headLimit);
  let bytesRead = head.length;
  let readStrategy: 'head' | 'full' = 'head';
  let outcome = await parseBytes(head, source.size);

  if (!headIsEnough(outcome) && headLimit < source.size) {
    const whole = await source.read(0, source.size);
    bytesRead += whole.length;
    const wholeOutcome = await parseBytes(whole, source.size);
    if (wholeOutcome.ok) {
      outcome = wholeOutcome;
      readStrategy = 'full';
    }
  }

  return buildResult(outcome, source, readStrategy, bytesRead);
}
