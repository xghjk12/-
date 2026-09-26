#!/usr/bin/env node
/**
 * 浏览器产物检查。
 *
 * 产品文档 8 的第一个风险是「music-metadata 的浏览器可用性与打包体积尚未验证」，
 * 这个脚本给出可重复的答案：
 *   1. 跑一次 `vite build`，构建失败就说明浏览器侧根本打不出包
 *   2. 扫描产物里有没有残留 `node:` 内置模块引用——有的话在浏览器里必然运行时报错
 *   3. 报告体积（原始 + gzip），作为"首屏要不要为它买单"的依据
 *
 * 用法：pnpm check:bundle
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-m0');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

console.log('== 1/3 构建浏览器产物 ==');
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

const files = listFiles(outDir);
const scripts = files.filter((file) => file.endsWith('.js'));
const otherAssets = files.filter((file) => !file.endsWith('.js'));

console.log('\n== 2/3 检查产物里是否残留 Node 内置模块 ==');
const fatal = [];
const warnings = [];

for (const file of scripts) {
  const source = readFileSync(file, 'utf8');
  const relative = path.relative(outDir, file);
  for (const match of source.matchAll(NODE_PROTOCOL)) {
    fatal.push(`${relative}: ${match[0]}`);
  }
  for (const match of source.matchAll(BARE_BUILTIN)) {
    warnings.push(`${relative}: ${match[0]}`);
  }
}

const uniqueWarnings = [...new Set(warnings.map((line) => line.split(': ')[1]))];

if (fatal.length > 0) {
  console.log(`  发现 ${fatal.length} 处 node: 协议引用（浏览器无法加载）：`);
  for (const line of [...new Set(fatal)].slice(0, 20)) console.log(`    ${line}`);
} else {
  console.log('  没有 node: 协议引用 —— 产物可以直接在浏览器里跑。');
}
if (uniqueWarnings.length > 0) {
  console.log(`  提醒：出现内置模块名 ${uniqueWarnings.join(', ')}（可能已被 shim）。`);
}

console.log('\n== 3/3 体积 ==');
const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
for (const file of scripts.sort(
  (a, b) => statSync(b).size - statSync(a).size,
)) {
  const source = readFileSync(file);
  console.log(
    `  ${path.relative(outDir, file).padEnd(28)} ${kb(source.length).padStart(9)}  ` +
      `gzip ${kb(gzipSync(source).length).padStart(9)}`,
  );
}
const jsTotal = scripts.reduce((sum, file) => sum + statSync(file).size, 0);
const assetTotal = otherAssets.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`  ${'JS 合计'.padEnd(28)} ${kb(jsTotal).padStart(9)}`);
console.log(`  ${'其他资源合计'.padEnd(28)} ${kb(assetTotal).padStart(9)}（测试样本音频）`);

if (fatal.length > 0) {
  console.error('\n浏览器产物检查未通过。');
  process.exit(1);
}
console.log('\n浏览器产物检查通过。');
