/**
 * 元数据区边界的纯逻辑：算准「元数据到哪儿结束」，不引用任何平台 API。
 *
 * 为什么需要它：扫描曲库解析元数据时，原实现固定读文件前 512KB。M0 实测发现真实文件的
 * 元数据区只有 8.6KB（FLAC）/ 351B（MP3），固定读 512KB 等于浪费几十倍 I/O——库里有几千
 * 首曲子时，这个浪费会直接变成扫描耗时；反过来，封面块排在 512KB 之后时又会被静默漏掉，
 * 属于"读得多还读不全"。
 *
 * 所以改为：先用一次小探测（`DEFAULT_PROBE_BYTES`，16KB）拿到头部，按容器结构算出元数据区
 * 的结束偏移，再按这个偏移精确读取。探测本身也要克制：只有真的能确认结束位置时才给出结果，
 * 确认不了就返回 `undefined`，由上层回退到固定上限——宁可多读一点，也不能因为头部被截断
 * 就把元数据切掉一半当成功。
 */

/** L1 探测读取的字节数：前 16KB。 */
export const DEFAULT_PROBE_BYTES: number = 16 * 1024;

/** FLAC 流标志：ASCII `fLaC`。 */
const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43] as const;

/** ID3v2 标志：ASCII `ID3`。 */
const ID3_MAGIC = [0x49, 0x44, 0x33] as const;

/** ID3v2 头长度（不含 footer）。 */
const ID3_HEADER_BYTES = 10;

/** ID3v2.4 的 footer 长度，标志位在头里、footer 跟在标签数据后面。 */
const ID3_FOOTER_BYTES = 10;

/** ID3v2.4 footer 标志位：头部偏移 5 的 bit 4。 */
const ID3_FLAG_FOOTER = 0x10;

/**
 * 上限保护：真实 FLAC 的块数是个位数，正常库不可能有上千块。
 * 存在的意义是防止「块长度为 0 且非最后一块」的构造/损坏文件让偏移原地打转。
 */
const FLAC_MAX_BLOCKS = 1024;

/** head 是否以给定字节序列开头。 */
function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (head[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * syncsafe 整数：每个字节只承载 7 位，最高位固定为 0。
 * 这样标签长度里就不会出现看起来像帧同步（0xFF 0xE?）的字节序列。
 */
function readSyncSafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! & 0x7f) << 21) |
    ((bytes[offset + 1]! & 0x7f) << 14) |
    ((bytes[offset + 2]! & 0x7f) << 7) |
    (bytes[offset + 3]! & 0x7f)
  );
}

/**
 * FLAC：`fLaC` 之后是一串 metadata block，每块 4 字节头 +
 * 「块类型与最后一块标志」在高位，长度是 24 位大端（不是 syncsafe）。
 */
function flacRegionEnd(head: Uint8Array): number | undefined {
  let offset: number = FLAC_MAGIC.length;

  for (let block = 0; block < FLAC_MAX_BLOCKS; block += 1) {
    // 连块头都读不全，就无从判断这里是不是最后一块。
    if (offset + 4 > head.length) return undefined;

    const header = head[offset]!;
    const length = (head[offset + 1]! << 16) | (head[offset + 2]! << 8) | head[offset + 3]!;
    const isLast = (header & 0x80) !== 0;
    const end = offset + 4 + length;

    // 看到「最后一块」标志就说明结束位置已经确定：块头里写明了长度，
    // 即使块体（典型是内嵌封面）超出 head，也能给出精确偏移。
    // 这一点很关键——否则 L2 精确读取永远不会触发，排在探测窗口之后的大封面会被静默漏掉。
    if (isLast) return end;

    // 不是最后一块，就还得继续读下一块的头；而它的头已经不在 head 里了，无法确认。
    if (end > head.length) return undefined;

    offset = end;
  }

  return undefined;
}

/** MP3：ID3v2 头固定 10 字节，标签总长是偏移 6–9 的 syncsafe 整数。 */
function id3RegionEnd(head: Uint8Array): number | undefined {
  if (head.length < ID3_HEADER_BYTES) return undefined;

  const size = readSyncSafe(head, 6);
  const hasFooter = (head[5]! & ID3_FLAG_FOOTER) !== 0;

  return ID3_HEADER_BYTES + size + (hasFooter ? ID3_FOOTER_BYTES : 0);
}

/**
 * 按容器结构计算「元数据区结束偏移」（不含音频数据）。
 * 无法判定时返回 undefined，由上层回退到固定上限。
 */
export function metadataRegionEnd(head: Uint8Array): number | undefined {
  if (startsWith(head, FLAC_MAGIC)) return flacRegionEnd(head);
  if (startsWith(head, ID3_MAGIC)) return id3RegionEnd(head);
  return undefined;
}
