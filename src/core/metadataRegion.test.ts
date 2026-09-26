/**
 * 元数据区边界计算的测试。
 *
 * 合成用例是主力：真实样本只能证明"某个文件的某个偏移恰好对"，而边界（块头被截断、
 * 长度越过探测窗口、非最后一块、syncsafe 高位）必须靠手工构造的字节来覆盖，
 * 这些正是"读少了会丢封面、读多了白费 I/O"的分界线。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROBE_BYTES, metadataRegionEnd } from './metadataRegion.js';

interface FlacBlockSpec {
  /** 块类型：0 STREAMINFO、1 PADDING、3 SEEKTABLE、4 VORBIS_COMMENT、6 PICTURE。 */
  type: number;
  /** 块体长度（不含 4 字节块头）。 */
  length: number;
  /** 是否置「最后一块」标志位。 */
  last?: boolean;
}

/** 独立算出元数据区结束偏移，不复用被测实现，避免"用同一个 bug 验证自己"。 */
function flacEnd(blocks: FlacBlockSpec[]): number {
  return blocks.reduce((offset, block) => offset + 4 + block.length, 4);
}

/** 造一个 FLAC 头部：4 字节 magic + 各块的块头与块体（块体内容填 0）。 */
function flacHead(blocks: FlacBlockSpec[]): Uint8Array {
  const head = new Uint8Array(flacEnd(blocks));
  head.set([0x66, 0x4c, 0x61, 0x43], 0);

  let offset = 4;
  for (const block of blocks) {
    head[offset] = (block.last ? 0x80 : 0) | (block.type & 0x7f);
    // 大端 24 位：写错端序的实现在这里会算出天文数字。
    head[offset + 1] = (block.length >>> 16) & 0xff;
    head[offset + 2] = (block.length >>> 8) & 0xff;
    head[offset + 3] = block.length & 0xff;
    offset += 4 + block.length;
  }

  return head;
}

/** syncsafe 编码：每字节 7 位。 */
function syncSafe(size: number): number[] {
  return [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f];
}

interface Id3Spec {
  /** 主版本号：3 = ID3v2.3，4 = ID3v2.4。 */
  version: number;
  /** 标签体长度（不含 10 字节头）。 */
  size: number;
  flags?: number;
  /** 头之后再补多少字节，用于模拟"只探测到头部"或"标签体已在手"。 */
  extra?: number;
}

function id3Head(spec: Id3Spec): Uint8Array {
  const head = new Uint8Array(10 + (spec.extra ?? 0));
  head.set([0x49, 0x44, 0x33, spec.version, 0x00, spec.flags ?? 0], 0);
  head.set(syncSafe(spec.size), 6);
  return head;
}

const fixtureDir = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));

describe('DEFAULT_PROBE_BYTES', () => {
  it('是 16KB', () => {
    expect(DEFAULT_PROBE_BYTES).toBe(16 * 1024);
  });
});

describe('metadataRegionEnd - FLAC', () => {
  it('真实布局形态：STREAMINFO + SEEKTABLE + VORBIS_COMMENT + PADDING', () => {
    const blocks: FlacBlockSpec[] = [
      { type: 0, length: 34 },
      { type: 3, length: 180 },
      { type: 4, length: 512 },
      { type: 1, length: 8192, last: true },
    ];

    expect(metadataRegionEnd(flacHead(blocks))).toBe(8938);
    expect(flacEnd(blocks)).toBe(8938);
  });

  it('返回的是元数据区结束位置，不受后面的音频数据影响', () => {
    const blocks: FlacBlockSpec[] = [
      { type: 0, length: 34 },
      { type: 4, length: 100, last: true },
    ];
    const head = flacHead([...blocks, { type: 1, length: 6000 }]);
    // 后半段在真实文件里是音频帧，不应被算进元数据区。
    head.fill(0xff, flacEnd(blocks));

    expect(metadataRegionEnd(head)).toBe(flacEnd(blocks));
  });

  it('长度按大端读取（小端实现会算出越界长度）', () => {
    const blocks: FlacBlockSpec[] = [{ type: 0, length: 0x0102, last: true }];

    expect(metadataRegionEnd(flacHead(blocks))).toBe(4 + 4 + 0x0102);
  });

  it('单块 metadata 也成立，长度为 0 时偏移仍前进', () => {
    expect(metadataRegionEnd(flacHead([{ type: 7, length: 0, last: true }]))).toBe(8);
  });

  it('块头不足 4 字节 → undefined', () => {
    const head = flacHead([
      { type: 0, length: 34 },
      { type: 4, length: 100, last: true },
    ]);

    // 只留下 magic + 第一个块头 + 3 字节残缺块头。
    expect(metadataRegionEnd(head.subarray(0, 4 + 4 + 34 + 3))).toBeUndefined();
    // magic 本身完整，但后面一个字节都没有。
    expect(metadataRegionEnd(head.subarray(0, 4))).toBeUndefined();
  });

  it('非最后一块的块体超出 head → undefined（无法继续确认结束位置）', () => {
    const head = flacHead([
      { type: 0, length: 34 },
      { type: 4, length: 2000 },
    ]);

    // 第二个块只探测到 6 字节块体，后面还有没有块、哪一块是最后一块都无从判断。
    expect(metadataRegionEnd(head.subarray(0, 42 + 10))).toBeUndefined();
  });

  it('最后一块的块体超出 head → 仍返回精确结束位置（大封面不会被漏掉）', () => {
    const blocks: FlacBlockSpec[] = [
      { type: 0, length: 34 },
      { type: 4, length: 2000, last: true },
    ];
    const truncatedLast = flacHead(blocks);

    // 块头里写明了长度，所以即使块体（典型是内嵌封面）没被探测覆盖，结束位置依然确定。
    // 这条是 L2「精确区读取」能触发的前提：否则封面排在探测窗口之后时会被静默漏掉。
    expect(metadataRegionEnd(truncatedLast.subarray(0, 42 + 10))).toBe(flacEnd(blocks));
  });

  it('一直没有最后一块标志、走完 head → undefined', () => {
    const blocks: FlacBlockSpec[] = [
      { type: 0, length: 34 },
      { type: 4, length: 100 },
    ];

    expect(metadataRegionEnd(flacHead(blocks))).toBeUndefined();
  });

  it('上千个零长度块不会死循环，超过上限返回 undefined', () => {
    const blocks: FlacBlockSpec[] = Array.from({ length: 1025 }, () => ({ type: 1, length: 0 }));

    expect(metadataRegionEnd(flacHead(blocks))).toBeUndefined();
  });

  it('1024 块以内、最后一块置位仍能给出结果', () => {
    const blocks: FlacBlockSpec[] = [
      ...Array.from({ length: 1023 }, () => ({ type: 1, length: 0 })),
      { type: 4, length: 20, last: true },
    ];

    expect(metadataRegionEnd(flacHead(blocks))).toBe(flacEnd(blocks));
  });

  it('magic 不完整或不是 fLaC → undefined', () => {
    expect(metadataRegionEnd(new Uint8Array([0x66, 0x4c, 0x61]))).toBeUndefined();
    expect(metadataRegionEnd(new Uint8Array([0x66, 0x4c, 0x61, 0x44]))).toBeUndefined();
  });
});

describe('metadataRegionEnd - MP3', () => {
  it('ID3v2.3：返回 10 + syncsafe 标签长度', () => {
    expect(metadataRegionEnd(id3Head({ version: 3, size: 1000 }))).toBe(1010);
    // syncsafe 逐字节验证：1000 = 7*128 + 104。
    expect(syncSafe(1000)).toEqual([0, 0, 7, 104]);
  });

  it('ID3v2.4 带 footer 标志位时再加 10', () => {
    expect(metadataRegionEnd(id3Head({ version: 4, size: 1000, flags: 0x10 }))).toBe(1020);
    expect(metadataRegionEnd(id3Head({ version: 4, size: 0, flags: 0x10 }))).toBe(20);
  });

  it('标签体还在探测窗口之外也能给出确定结果（头里就写明了长度）', () => {
    expect(metadataRegionEnd(id3Head({ version: 3, size: 300000 }))).toBe(300010);
  });

  it('头不足 10 字节 → undefined', () => {
    for (let length = 0; length < 10; length += 1) {
      const head = id3Head({ version: 3, size: 1000 }).subarray(0, length);
      expect(metadataRegionEnd(head), `长度 ${length}`).toBeUndefined();
    }
  });

  it('非 ID3 开头 → undefined', () => {
    // RIFF/WAVE 头。
    expect(metadataRegionEnd(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41]))).toBeUndefined();
    expect(metadataRegionEnd(new Uint8Array([0x49, 0x44, 0x32, 0x03, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });
});

describe('metadataRegionEnd - 边界与非法输入', () => {
  it('空数组 → undefined', () => {
    expect(metadataRegionEnd(new Uint8Array(0))).toBeUndefined();
  });

  it('标签长度为 0 时只返回头部长度', () => {
    expect(metadataRegionEnd(id3Head({ version: 3, size: 0 }))).toBe(10);
  });

  it('syncsafe 最大值（4 字节全为 0x7F）', () => {
    const head = id3Head({ version: 3, size: 0 });
    head.set([0x7f, 0x7f, 0x7f, 0x7f], 6);

    expect(metadataRegionEnd(head)).toBe(10 + 0x0fffffff);
  });

  it('syncsafe 只取低 7 位：高位为 1 的字节按同一数值解释', () => {
    const low = id3Head({ version: 3, size: 0 });
    low.set([0x00, 0x00, 0x03, 0x7f], 6);

    const high = id3Head({ version: 3, size: 0 });
    high.set([0x80, 0x80, 0x83, 0xff], 6);

    expect(metadataRegionEnd(high)).toBe(metadataRegionEnd(low));
    expect(metadataRegionEnd(low)).toBe(10 + (3 << 7) + 0x7f);
  });
});

describe('metadataRegionEnd - 真实样本交叉验证', () => {
  it('sample-cn.flac 的元数据区在几百字节到几十 KB 之间，且不超过文件大小', async () => {
    const bytes = new Uint8Array(await readFile(path.join(fixtureDir, 'sample-cn.flac')));
    const head = bytes.subarray(0, DEFAULT_PROBE_BYTES);

    const end = metadataRegionEnd(head);

    expect(end).toBeDefined();
    expect(end!).toBeGreaterThanOrEqual(200);
    expect(end!).toBeLessThanOrEqual(64 * 1024);
    expect(end!).toBeLessThanOrEqual(bytes.length);
    // 探测窗口足够覆盖该样本，说明 16KB 的 L1 读法对真实 FLAC 成立。
    expect(end!).toBeLessThan(DEFAULT_PROBE_BYTES);
    // 对比现状：固定 512KB 的读法在本样本上多读了几十倍。
    expect(end!).toBeLessThan(512 * 1024);
  });

  it('sample-cn.mp3 的 ID3v2 标签能在探测窗口内确定结束位置', async () => {
    const bytes = new Uint8Array(await readFile(path.join(fixtureDir, 'sample-cn.mp3')));
    const head = bytes.subarray(0, DEFAULT_PROBE_BYTES);

    const end = metadataRegionEnd(head);

    expect(end).toBeDefined();
    expect(end!).toBeGreaterThanOrEqual(10);
    expect(end!).toBeLessThanOrEqual(bytes.length);
  });
});
