/**
 * 目录递归遍历的 M0 验证：在临时目录里搭出一棵真实的树，
 * 走完"遍历 → 分类 → 逐个解析元数据"的完整链路。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { nodeMusicSource } from './nodeMusicSource.js';
import { readMetadata } from './metadata.js';

const fixtureDir = fileURLToPath(new URL('../../tests/fixtures/', import.meta.url));

let root: string;

async function copyFixture(name: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(fixtureDir, name), target);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qingyin-m0-'));
  await copyFixture('sample-cn.flac', path.join(root, '青花瓷.flac'));
  await copyFixture('sample-cn.mp3', path.join(root, '专辑', '01 - 青花瓷.mp3'));
  await copyFixture('plain.mp3', path.join(root, '专辑', 'CD2', 'plain.mp3'));
  await copyFixture('fake.ape', path.join(root, '专辑', 'CD2', 'fake.ape'));
  // 干扰项：非音频文件不应该出现在结果里
  await writeFile(path.join(root, 'cover.jpg'), 'not audio');
  await writeFile(path.join(root, '专辑', 'notes.txt'), 'not audio');
  await mkdir(path.join(root, '空目录'), { recursive: true });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('nodeMusicSource.listAudioFiles', () => {
  it('递归找出全部音频文件，忽略非音频文件与空目录', async () => {
    const source = nodeMusicSource(root);
    const files = await source.listAudioFiles();
    const paths = files.map((file) => file.path).sort();

    expect(paths).toEqual(
      ['青花瓷.flac', '专辑/01 - 青花瓷.mp3', '专辑/CD2/plain.mp3', '专辑/CD2/fake.ape'].sort(),
    );
  });

  it('相对路径用 posix 分隔符，且带出大小与修改时间', async () => {
    const source = nodeMusicSource(root);
    const files = await source.listAudioFiles();
    const flac = files.find((file) => file.path === '青花瓷.flac');

    expect(flac).toBeDefined();
    expect(flac?.name).toBe('青花瓷.flac');
    expect(flac?.size).toBeGreaterThan(1000);
    expect(flac?.lastModified).toBeGreaterThan(0);
    expect(files.every((file) => !file.path.includes('\\'))).toBe(true);
  });

  it('进度回调单调递增到总数', async () => {
    const source = nodeMusicSource(root);
    const seen: number[] = [];
    const files = await source.listAudioFiles((found) => seen.push(found));

    expect(seen).toHaveLength(files.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(files.length);
  });

  it('rootName 为根目录名', async () => {
    const source = nodeMusicSource(root);
    expect(source.rootName).toBe(path.basename(root));
  });
});

describe('遍历 → 解析 的完整链路', () => {
  it('每个音频文件都能打开并读出元数据', async () => {
    const source = nodeMusicSource(root);
    const files = await source.listAudioFiles();

    const results = new Map<string, Awaited<ReturnType<typeof readMetadata>>>();
    for (const file of files) {
      results.set(file.path, await readMetadata(await source.open(file)));
    }

    // flac：完整标签
    const flac = results.get('青花瓷.flac');
    expect(flac?.title).toBe('青花瓷');
    expect(flac?.artist).toBe('周杰伦');
    expect(flac?.durationSec).toBeCloseTo(2, 1);

    // 带音轨号前缀的文件名，标题仍然来自标签而不是文件名
    const mp3 = results.get('专辑/01 - 青花瓷.mp3');
    expect(mp3?.title).toBe('青花瓷');
    expect(mp3?.titleFromFileName).toBe(false);

    // 无标签文件回退到文件名（去掉扩展名）
    const plain = results.get('专辑/CD2/plain.mp3');
    expect(plain?.title).toBe('plain');
    expect(plain?.titleFromFileName).toBe(true);

    // 损坏文件不中断整轮扫描
    const broken = results.get('专辑/CD2/fake.ape');
    expect(broken?.parseError).toBeTruthy();
    expect(broken?.title).toBe('fake');
  });
});
