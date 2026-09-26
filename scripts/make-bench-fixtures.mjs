#!/usr/bin/env node
/**
 * 生成基准测试用的曲库（`node scripts/make-bench-fixtures.mjs [数量]`）。
 *
 * 目的：把「3000 首到底要多久」从文档里的一句预算，变成可复现的实测。
 * 需要**真实文件**（而不是假对象），因为要量的正是「每个文件取一次 size/mtime」这段 I/O。
 *
 * 做法：把 `tests/fixtures/sample-cn.mp3` 截成 24KB 反复写出去——
 *  - 保留完整的 ID3v2 标签，于是走的是 L1 探测（真实曲库的常态路径），不是 L3 全文件兜底
 *  - 24KB × 3000 ≈ 72MB，比直接复制 50KB 的原文件省一半磁盘
 * 另外掺一些假的 `.ape`（验证"能读标签但放不出声"的标记）与非音频文件（验证过滤）。
 *
 * 产物目录 `.bench-library/` 已进 .gitignore，随时可以删掉重来。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.bench-library');
const SOURCE = path.join(root, 'tests', 'fixtures', 'sample-cn.mp3');
const APE_SOURCE = path.join(root, 'tests', 'fixtures', 'fake.ape');

/** 截取长度：保留 ID3v2 标签与第一个 MPEG 帧，足够解析出标题与时长。 */
const SNIPPET_BYTES = 24 * 1024;
const ALBUMS = 30;
const APE_EVERY = 97;

const count = Number.parseInt(process.argv[2] ?? '3000', 10);
if (!Number.isFinite(count) || count <= 0) {
  console.error('用法：node scripts/make-bench-fixtures.mjs [数量]');
  process.exit(1);
}

const source = await readFile(SOURCE);
const snippet = source.subarray(0, Math.min(SNIPPET_BYTES, source.length));
const apeBytes = await readFile(APE_SOURCE);

console.log(`准备生成 ${count} 首（每首 ${(snippet.length / 1024).toFixed(0)}KB，来自 ${path.basename(SOURCE)}）`);
await rm(outDir, { recursive: true, force: true });

const perAlbum = Math.ceil(count / ALBUMS);
let written = 0;

for (let album = 0; album < ALBUMS && written < count; album += 1) {
  const albumName = `专辑 ${String(album + 1).padStart(3, '0')}`;
  const albumDir = path.join(outDir, albumName);
  await mkdir(albumDir, { recursive: true });

  // 每个专辑目录里放一个非音频文件，用来验证遍历会把它过滤掉
  await writeFile(path.join(albumDir, 'cover.jpg'), 'not really a jpeg');

  for (let track = 0; track < perAlbum && written < count; track += 1) {
    const index = written + 1;
    const isApe = index % APE_EVERY === 0;
    const extension = isApe ? 'ape' : 'mp3';
    const name = `${String(track + 1).padStart(3, '0')} 曲目 ${String(index).padStart(5, '0')}.${extension}`;
    await writeFile(path.join(albumDir, name), isApe ? apeBytes : snippet);
    written += 1;
  }

  if (album % 5 === 0) process.stdout.write(`\r  已写入 ${written}/${count}`);
}

process.stdout.write(`\r  已写入 ${written}/${count}\n`);
console.log(`完成：${path.relative(root, outDir)}（${written} 个音频文件）`);
