#!/usr/bin/env node
/**
 * 生成 M0 技术验证用的音频样本。
 *
 * 样本会被提交进仓库，测试直接读取它们，因此 `pnpm test` 不依赖本机是否装有 ffmpeg。
 * 只有需要重新生成样本时才执行 `pnpm fixtures`（要求本机有 ffmpeg）。
 *
 * 用法：
 *   node scripts/make-fixtures.mjs
 *   FFMPEG=D:\path\to\ffmpeg.exe node scripts/make-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'tests', 'fixtures');
const coverJpg = path.join(outDir, '_cover.jpg');

/** 本机已知的 ffmpeg 位置，可用 FFMPEG 环境变量覆盖。 */
const CANDIDATES = [
  process.env.FFMPEG,
  'ffmpeg',
  'D:\\ACLOS\\Cross\\recorder-release\\ffmpeg.exe',
].filter(Boolean);

function resolveFfmpeg() {
  for (const candidate of CANDIDATES) {
    try {
      execFileSync(candidate, ['-hide_banner', '-version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 试下一个
    }
  }
  throw new Error(
    `找不到可用的 ffmpeg。已尝试：${CANDIDATES.join(', ')}\n` +
      '请用 FFMPEG=<可执行文件路径> 指定。',
  );
}

const ffmpeg = resolveFfmpeg();

function run(args, label) {
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? String(error);
    throw new Error(`生成 ${label} 失败：\n${detail}`);
  }
  const { size } = statSync(args.at(-1));
  console.log(`  ${path.basename(args.at(-1)).padEnd(18)} ${String(size).padStart(7)} B`);
}

mkdirSync(outDir, { recursive: true });

// 封面：一张纯色 JPEG，后续作为 attached_pic 内嵌进音频文件。
// 用 JPEG 而非 PNG 是因为本机 ffmpeg 构建未包含 PNG 编解码器，且真实文件里封面多为 JPEG。
run(
  [
    '-f', 'lavfi', '-i', 'color=c=0x2E7D32:s=96x96',
    '-frames:v', '1', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', coverJpg,
  ],
  '封面',
);

// 中文标签 + 内嵌封面的 FLAC。时长在 STREAMINFO 头里，读取不需要扫全文件。
run(
  [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-i', coverJpg,
    '-map', '0:a', '-map', '1:v',
    '-c:a', 'flac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
    '-metadata', 'title=青花瓷',
    '-metadata', 'artist=周杰伦',
    '-metadata', 'album=我很忙',
    '-metadata', 'track=1',
    '-metadata', 'date=2007',
    path.join(outDir, 'sample-cn.flac'),
  ],
  'sample-cn.flac',
);

// 中文标签 + 内嵌封面的 MP3，强制 ID3v2.3（中文老文件里最常见）。
run(
  [
    '-f', 'lavfi', '-i', 'sine=frequency=523.25:duration=2',
    '-i', coverJpg,
    '-map', '0:a', '-map', '1:v',
    '-c:a', 'mp3_mf', '-b:a', '192k', '-ac', '2', '-ar', '44100',
    '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
    '-id3v2_version', '3',
    '-metadata', 'title=青花瓷',
    '-metadata', 'artist=周杰伦',
    '-metadata', 'album=我很忙',
    '-metadata', 'track=1',
    path.join(outDir, 'sample-cn.mp3'),
  ],
  'sample-cn.mp3',
);

// 完全没有标签的 MP3：用来验证「标题回退到文件名」的逻辑。
run(
  [
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1',
    '-c:a', 'mp3_mf', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    '-map_metadata', '-1',
    path.join(outDir, 'plain.mp3'),
  ],
  'plain.mp3',
);

// 浏览器无法解码的格式：只用扩展名参与格式分类，内容不需要是合法的 APE。
const fakeApe = path.join(outDir, 'fake.ape');
writeFileSync(fakeApe, 'not a real ape file');
console.log(`  ${'fake.ape'.padEnd(18)} ${String(statSync(fakeApe).size).padStart(7)} B`);

rmSync(coverJpg, { force: true });
console.log(`\n样本已写入 ${path.relative(root, outDir)}`);
