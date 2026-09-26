/**
 * 元数据解析的 M0 验证测试，输入是 `scripts/make-fixtures.mjs` 用 ffmpeg 生成的真实文件。
 *
 * 这些用例锁住的是 M0 的两个关键结论：
 *  1. flac / mp3 的标签、封面、时长都能正确读出（含中文）
 *  2. 头部够用时不读整个文件；头部不够时才回退——用"读了哪些区间"来断言，而不是靠感觉
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ByteSource } from './byteSource.js';
import { DEFAULT_HEAD_BYTES, readMetadata } from './metadata.js';

const fixtureDir = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));

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

describe('readMetadata：读取策略（I/O 行为）', () => {
  it('头部够用时只读一次，不读整个文件', async () => {
    const source = await fixtureSource('sample-cn.flac');
    // 8KB 远小于文件本身，但已包含 STREAMINFO 与 Vorbis comment
    const metadata = await readMetadata(source, { headBytes: 8192 });

    expect(metadata.readStrategy).toBe('head');
    expect(source.reads).toEqual([[0, 8192]]);
    expect(metadata.bytesRead).toBe(8192);
    expect(metadata.title).toBe('青花瓷');
    expect(metadata.durationSec).toBeCloseTo(2, 1);
    expect(source.size).toBeGreaterThan(8192);
  });

  it('头部不足以读出标签时，回退读整个文件', async () => {
    const source = await fixtureSource('sample-cn.flac');
    const metadata = await readMetadata(source, { headBytes: 64 });

    expect(metadata.readStrategy).toBe('full');
    expect(source.reads).toEqual([
      [0, 64],
      [0, source.size],
    ]);
    expect(metadata.title).toBe('青花瓷');
  });

  it('文件小于头部上限时只读一次，不会重复读', async () => {
    const source = await fixtureSource('sample-cn.mp3');
    expect(source.size).toBeLessThan(DEFAULT_HEAD_BYTES);

    const metadata = await readMetadata(source);
    expect(source.reads).toEqual([[0, source.size]]);
    expect(metadata.readStrategy).toBe('head');
  });

  it('字节数统计与实际读取量一致', async () => {
    const source = await fixtureSource('sample-cn.flac');
    const metadata = await readMetadata(source, { headBytes: 4096 });
    const total = source.reads.reduce((sum, [from, to]) => sum + (to - from), 0);
    expect(metadata.bytesRead).toBe(total);
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
});
