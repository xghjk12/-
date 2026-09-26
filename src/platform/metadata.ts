/**
 * 元数据解析：三级读取策略（技术方案 4.1）。
 *
 * M0 的两条实测结论决定了这里的形状：
 *  1. 解析耗时与读多少字节无关（`parseBuffer` 只走它需要的元数据块），成本纯粹在磁盘 I/O
 *  2. 真实文件的元数据区小得惊人——FLAC 8.6KB / MP3 351B，而固定读 512KB 是所需量的几十倍，
 *     却又**不能保证**覆盖排在后面的大封面
 *
 * 所以改成按容器结构算准范围：
 *  - L1 探测：前 16KB。同时用它算出元数据区结束位置
 *  - L2 精确区：元数据区比探测更长时，只多读这一块（大封面不会再被静默漏掉）
 *  - L3 全文件：L1/L2 都没读出标题/艺术家/专辑时（兜住只写在文件尾部的 ID3v1 老 mp3）
 *
 * 另外两件事也在这里兜住：解析失败不抛异常（一个坏文件不中断整次扫描），
 * 以及 GBK 老标签的回退（技术方案 4.3）。
 */
import { parseBuffer, selectCover } from 'music-metadata';
import { DEFAULT_PROBE_BYTES, metadataRegionEnd } from '../core/metadataRegion.js';
import { guessTitle } from '../core/library.js';
import { fixGbkMojibake } from '../core/tagEncoding.js';
import type { ByteSource } from './byteSource.js';

export { DEFAULT_PROBE_BYTES };

export interface CoverImage {
  mimeType: string;
  data: Uint8Array;
}

/** 实际采用的读取级别，用于在扫描统计里解释代价。 */
export type ReadStrategy = 'probe' | 'region' | 'full';

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
  readStrategy: ReadStrategy;
  /** 实际读取的字节数，测试用它锁住「头部够用就不读整文件」。 */
  bytesRead: number;
  /** 解析失败的原因；成功时为 undefined。 */
  parseError?: string;
}

type ParsedMetadata = Awaited<ReturnType<typeof parseBuffer>>;

type ParseOutcome = { ok: true; metadata: ParsedMetadata } | { ok: false; error: Error };

async function parseBytes(bytes: Uint8Array, totalSize: number): Promise<ParseOutcome> {
  try {
    return { ok: true, metadata: await parseBuffer(bytes, { size: totalSize }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 已经读到足够的标签信息，不必再往下读。 */
function hasCoreTags(outcome: ParseOutcome): boolean {
  if (!outcome.ok) return false;
  const { title, artist, album } = outcome.metadata.common;
  return Boolean(title || artist || album);
}

function buildResult(
  outcome: ParseOutcome,
  source: ByteSource,
  readStrategy: ReadStrategy,
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
  // GBK 老标签只会出现在标签里；文件名回退出来的标题本来就是对的不必处理
  const title = fixGbkMojibake(common.title);

  return {
    title: title ?? fallbackTitle,
    titleFromFileName: !title,
    artist: fixGbkMojibake(common.artist),
    album: fixGbkMojibake(common.album),
    albumArtist: fixGbkMojibake(common.albumartist),
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
  /** 覆盖 L1 探测长度，测试用它构造「探测区不够」的场景。 */
  probeBytes?: number;
}

export async function readMetadata(
  source: ByteSource,
  options: ReadMetadataOptions = {},
): Promise<TrackMetadata> {
  const probeBytes = options.probeBytes ?? DEFAULT_PROBE_BYTES;
  const probeLimit = Math.min(probeBytes, source.size);

  // ---- L1 探测 ----
  const probe = await source.read(0, probeLimit);
  let bytesRead = probe.length;
  let coveredBytes = probe.length;
  let readStrategy: ReadStrategy = 'probe';
  let outcome = await parseBytes(probe, source.size);

  // ---- L2 精确区：只多读元数据区这一块 ----
  const region = metadataRegionEnd(probe);
  if (region !== undefined && region > probe.length && region <= source.size) {
    const bytes = await source.read(0, region);
    bytesRead += bytes.length;
    coveredBytes = Math.max(coveredBytes, bytes.length);
    const regionOutcome = await parseBytes(bytes, source.size);
    if (regionOutcome.ok) {
      outcome = regionOutcome;
      readStrategy = 'region';
    }
  }

  // ---- L3 全文件：只在前面都没读出核心标签时 ----
  if (!hasCoreTags(outcome) && coveredBytes < source.size) {
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
