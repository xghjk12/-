#!/usr/bin/env node
/**
 * 产物检查（`pnpm check:bundle`）。
 *
 * 它回答三个可复现的问题：
 *   1. 浏览器产物能不能构建（构建失败说明浏览器侧根本打不出包）
 *   2. 产物里有没有残留 `node:` 内置模块引用——有的话在浏览器里必然运行时报错
 *      （这条是产品文档 8 节第一个风险的验证手段，M0 起一直保留）
 *   3. PWA 外壳是否齐全：manifest、Service Worker、图标都生成了，且 **不预缓存音频样本**
 *
 * 用法：pnpm check:bundle
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

console.log('== 1/4 构建浏览器产物 ==');
execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });

/** 明确带 `node:` 前缀的引用在浏览器里一定会炸。 */
const NODE_PROTOCOL = /["'`]node:[a-z0-9_/.-]+["'`]/g;
/** 不带前缀的内置模块名，可能是被 shim 过的，只作为提醒。 */
const BARE_BUILTIN =
  /(?:from|import|require)\s*\(?\s*["'`](fs|path|stream|util|events|os|crypto|zlib|child_process|worker_threads|net|tls|http|https|assert)["'`]/g;

function listFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(absolute));
    else result.push(absolute);
  }
  return result;
}

console.log('\n== 2/4 检查产物里是否残留 Node 内置模块 ==');
const files = listFiles(outDir);
const scripts = files.filter((file) => file.endsWith('.js'));
const failures = [];
const warnings = [];

for (const file of scripts) {
  const source = readFileSync(file, 'utf8');
  const relative = path.relative(outDir, file);
  for (const match of source.matchAll(NODE_PROTOCOL)) failures.push(`${relative}: ${match[0]}`);
  for (const match of source.matchAll(BARE_BUILTIN)) warnings.push(`${relative}: ${match[0]}`);
}

const uniqueWarnings = [...new Set(warnings.map((line) => line.split(': ')[1]))];
if (failures.length > 0) {
  console.log(`  发现 ${failures.length} 处 node: 协议引用（浏览器无法加载）：`);
  for (const line of [...new Set(failures)].slice(0, 20)) console.log(`    ${line}`);
} else {
  console.log('  没有 node: 协议引用 —— 产物可以直接在浏览器里跑。');
}
if (uniqueWarnings.length > 0) {
  console.log(`  提醒：出现内置模块名 ${uniqueWarnings.join(', ')}（可能已被 shim）。`);
}

console.log('\n== 3/4 体积 ==');
const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
for (const file of scripts.sort((a, b) => statSync(b).size - statSync(a).size).slice(0, 8)) {
  const source = readFileSync(file);
  console.log(
    `  ${path.relative(outDir, file).padEnd(34)} ${kb(source.length).padStart(9)}  ` +
      `gzip ${kb(gzipSync(source).length).padStart(9)}`,
  );
}
const jsTotal = scripts.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`  ${'JS 合计'.padEnd(34)} ${kb(jsTotal).padStart(9)}`);

console.log('\n== 4/4 PWA 外壳 ==');
const required = [
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  path.join('icons', 'icon-192.png'),
  path.join('icons', 'icon-512.png'),
];
for (const relative of required) {
  const target = path.join(outDir, relative);
  const exists = existsSync(target);
  console.log(`  ${exists ? '✓' : '✗'} ${relative}`);
  if (!exists) failures.push(`缺少 PWA 产物：${relative}`);
}

// Service Worker 不该把内置自检用的音频样本预缓存进 shell
const swPath = path.join(outDir, 'sw.js');
if (existsSync(swPath)) {
  const sw = readFileSync(swPath, 'utf8');
  const audio = ['.flac', '.mp3', '.ape'].filter((extension) => sw.includes(extension));
  if (audio.length > 0) {
    failures.push(`Service Worker 预缓存了音频样本：${audio.join(', ')}`);
    console.log(`  ✗ Service Worker 里出现了音频样本：${audio.join(', ')}`);
  } else {
    console.log('  ✓ Service Worker 未预缓存音频样本');
  }
}

if (failures.length > 0) {
  console.error('\n产物检查未通过。');
  process.exit(1);
}
console.log('\n产物检查通过。');
