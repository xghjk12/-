/**
 * 元数据解析的测试，输入是 `scripts/make-fixtures.mjs` 用 ffmpeg 生成的真实文件。
 *
 * 锁住三件事：
 *  1. flac / mp3 的标签、封面、时长都能正确读出（含中文）
 *  2. 三级读取策略（技术方案 4.1）真的按预期走——用"读了哪些区间"断言，而不是靠感觉：
 *     L1 探测 → 元数据区更大时只多读那一块 → 都读不出标签时才读整文件
 *  3. 失败与不支持格式不会抛异常，坏文件不中断扫描
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ByteSource } from './byteSource.js';
import { DEFAULT_PROBE_BYTES, readMetadata } from './metadata.js';

const fixtureDir = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));

/** fixture 的 FLAC 元数据区实测结束偏移（STREAMINFO + SEEKTABLE + VORBIS_COMMENT + PICTURE）。 */
const FLAC_FIXTURE_REGION_END = 8697;

interface RecordingSource extends ByteSource {
  /** 记录每次读取的 [start, end)，用于断言 I/O 行为。 */
  reads: Array<[number, number]>;
}

async function fixtureSource(fileName: string, overrideName?: string): Promise<RecordingSource> {
  const bytes = new Uint8Array(await readFile(path.join(fixtureDir, fileName)));
  const reads: Array<[number, number]> = [];
  return {
    name: overrideName ?? fileName,
    size: bytes.length,
    reads,
    async read(start, end) {
      const from = Math.max(0, Math.min(start, bytes.length));
      const to = Math.max(from, Math.min(end, bytes.length));
      reads.push([from, to]);
      return bytes.subarray(from, to);
    },
  };
}

describe('readMetadata：FLAC', () => {
  it('读出中文标签、音轨号、年份与内嵌封面', async () => {
    const metadata = await readMetadata(await fixtureSource('sample-cn.flac'));

    expect(metadata.parseError).toBeUndefined();
    expect(metadata.title).toBe('青花瓷');
    expect(metadata.titleFromFileName).toBe(false);
    expect(metadata.artist).toBe('周杰伦');
    expect(metadata.album).toBe('我很忙');
    expect(metadata.trackNo).toBe(1);
    expect(metadata.year).toBe(2007);
    expect(metadata.container).toBe('FLAC');
    expect(metadata.lossless).toBe(true);
    expect(metadata.sampleRate).toBe(44100);
  });

  it('时长来自 STREAMINFO 头，不需要扫全文件', async () => {
    const metadata = await readMetadata(await fixtureSource('sample-cn.flac'));
    expect(metadata.durationSec).toBeCloseTo(2, 1);
  });

  it('封面可读出，且是 JPEG 字节', async () => {
    const metadata = await readMetadata(await fixtureSource('sample-cn.flac'));
    expect(metadata.cover?.mimeType).toBe('image/jpeg');
    expect(metadata.cover?.data.length).toBeGreaterThan(0);
    // JPEG 魔术字节 FF D8
    expect([metadata.cover?.data[0], metadata.cover?.data[1]]).toEqual([0xff, 0xd8]);
  });
});

describe('readMetadata：MP3', () => {
  it('读出中文标签与封面（ID3v2.3）', async () => {
    const metadata = await readMetadata(await fixtureSource('sample-cn.mp3'));

    expect(metadata.parseError).toBeUndefined();
    expect(metadata.title).toBe('青花瓷');
    expect(metadata.artist).toBe('周杰伦');
    expect(metadata.album).toBe('我很忙');
    expect(metadata.container).toBe('MPEG');
    expect(metadata.lossless).toBe(false);
    expect(metadata.bitrate).toBe(192000);
    expect(metadata.cover?.mimeType).toBe('image/jpeg');
  });

  it('时长正确', async () => {
    const metadata = await readMetadata(await fixtureSource('sample-cn.mp3'));
    expect(metadata.durationSec).toBeCloseTo(2, 1);
  });

  it('没有标签时回退到文件名', async () => {
    const metadata = await readMetadata(await fixtureSource('plain.mp3'));

    expect(metadata.parseError).toBeUndefined();
    expect(metadata.title).toBe('plain');
    expect(metadata.titleFromFileName).toBe(true);
    expect(metadata.artist).toBeUndefined();
    expect(metadata.cover).toBeUndefined();
  });
});

describe('readMetadata：三级读取策略（I/O 行为）', () => {
  it('L1：探测区覆盖整个元数据区时只读一次', async () => {
    const source = await fixtureSource('sample-cn.flac');
    // 默认 16KB 探测已覆盖 8697 字节的元数据区
    const metadata = await readMetadata(source);

    expect(metadata.readStrategy).toBe('probe');
    expect(source.reads).toEqual([[0, DEFAULT_PROBE_BYTES]]);
    expect(metadata.bytesRead).toBe(DEFAULT_PROBE_BYTES);
    expect(metadata.title).toBe('青花瓷');
    expect(metadata.cover?.mimeType).toBe('image/jpeg');
  });

  it('L2：元数据区大于探测窗口时只多读这一块，不读整文件', async () => {
    const source = await fixtureSource('sample-cn.flac');
    // 4KB 探测：块头都在里面（够算出元数据区），但封面在窗口之外
    const metadata = await readMetadata(source, { probeBytes: 4096 });

    expect(metadata.readStrategy).toBe('region');
    expect(source.reads).toEqual([
      [0, 4096],
      [0, FLAC_FIXTURE_REGION_END],
    ]);
    expect(metadata.bytesRead).toBe(4096 + FLAC_FIXTURE_REGION_END);
    // 关键收益：排在探测窗口之后的大封面不会被静默漏掉，而且始终没有读整个文件
    expect(metadata.cover?.mimeType).toBe('image/jpeg');
    expect(source.reads.every(([, end]) => end < source.size)).toBe(true);
  });

  it('L3：探测区读不出标签时回退读整个文件', async () => {
    const source = await fixtureSource('sample-cn.flac');
    // 64 字节连 metadata block 都走不完
    const metadata = await readMetadata(source, { probeBytes: 64 });

    expect(metadata.readStrategy).toBe('full');
    expect(source.reads).toEqual([
      [0, 64],
      [0, source.size],
    ]);
    expect(metadata.title).toBe('青花瓷');
  });

  it('探测上限大于文件本身时只读一次，不会重复读', async () => {
    const source = await fixtureSource('sample-cn.mp3');
    const metadata = await readMetadata(source, { probeBytes: 1024 * 1024 });

    expect(source.reads).toEqual([[0, source.size]]);
    expect(metadata.readStrategy).toBe('probe');
  });

  it('字节数统计与实际读取量一致', async () => {
    const source = await fixtureSource('sample-cn.flac');
    const metadata = await readMetadata(source, { probeBytes: 4096 });
    const total = source.reads.reduce((sum, [from, to]) => sum + (to - from), 0);
    expect(metadata.bytesRead).toBe(total);
  });

  it('没有标签的文件才需要读整文件（L3 是兜底而不是常规路径）', async () => {
    const source = await fixtureSource('plain.mp3');
    const metadata = await readMetadata(source);

    expect(metadata.readStrategy).toBe('full');
    expect(source.reads).toEqual([
      [0, DEFAULT_PROBE_BYTES],
      [0, source.size],
    ]);
    expect(metadata.titleFromFileName).toBe(true);
  });
});

describe('readMetadata：异常与不支持格式', () => {
  it('损坏文件不抛异常，给出 parseError 并回退文件名', async () => {
    const metadata = await readMetadata(await fixtureSource('fake.ape'));

    expect(metadata.parseError).toBeTruthy();
    expect(metadata.title).toBe('fake');
    expect(metadata.titleFromFileName).toBe(true);
    expect(metadata.durationSec).toBeUndefined();
    expect(metadata.cover).toBeUndefined();
  });

  it('空文件同样不抛异常', async () => {
    const empty: RecordingSource = {
      name: 'empty.mp3',
      size: 0,
      reads: [],
      async read() {
        return new Uint8Array(0);
      },
    };
    const metadata = await readMetadata(empty);
    expect(metadata.parseError).toBeTruthy();
    expect(metadata.title).toBe('empty');
  });

  it('文件名里的音轨号前缀不会留在回退标题里', async () => {
    const metadata = await readMetadata(await fixtureSource('fake.ape', '03 - 某首老歌.ape'));
    expect(metadata.title).toBe('某首老歌');
  });
});
