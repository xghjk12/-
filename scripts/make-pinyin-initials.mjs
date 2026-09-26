#!/usr/bin/env node
/**
 * 生成拼音声母表（`node scripts/make-pinyin-initials.mjs`）。
 *
 * 为什么能自动生成：GB2312 的一级汉字区（0xB0A1–0xD7F9，共 3755 字）**是按拼音顺序排列的**。
 * 所以只要知道每个声母区间的「第一个字」，就能靠位置推出整个区间里每个字的声母——
 * 不需要任何拼音词库，也就不会为了拼音搜索引入几百 KB 的依赖。
 *
 * 表里存两个等长字符串：`CHARS`（按 GB2312 顺序的汉字）与 `INITIALS`（对应声母，无拼音的字为空格）。
 * 运行时用一张 Map 做 O(1) 查询（见 `src/core/pinyin.ts`）。
 *
 * 生成完会做一轮**抽查**：拿一批众所周知的字/词验证声母，任何一条不符就直接失败退出，
 * 避免把一张错的表写进仓库。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'core', 'pinyinTable.ts');

/**
 * 每个声母区间的首字（GB2312 一级字区的经典边界表）。
 * 注意没有 i / u / v 开头的音节。
 */
const BOUNDARIES = [
  ['a', '啊'],
  ['b', '芭'],
  ['c', '擦'],
  ['d', '搭'],
  ['e', '蛾'],
  ['f', '发'],
  ['g', '噶'],
  ['h', '哈'],
  ['j', '击'],
  ['k', '喀'],
  ['l', '垃'],
  ['m', '妈'],
  ['n', '拿'],
  ['o', '哦'],
  ['p', '啪'],
  ['q', '期'],
  ['r', '然'],
  ['s', '撒'],
  ['t', '塌'],
  ['w', '挖'],
  ['x', '昔'],
  ['y', '压'],
  ['z', '匝'],
];

/** GB2312 一级汉字区：区 0xB0–0xD7，位 0xA1–0xFE。 */
const GBK_START = [0xb0, 0xa1];
const GBK_END = [0xd7, 0xf9];
const CHARS_PER_ROW = 0xfe - 0xa1 + 1; // 94

console.log('== 1/4 解码 GB2312 一级字区 ==');
const decoder = new TextDecoder('gbk', { fatal: false });
const bytes = [];
for (let high = GBK_START[0]; high <= GBK_END[0]; high += 1) {
  for (let low = 0xa1; low <= 0xfe; low += 1) {
    bytes.push(high, low);
  }
}
const decoded = decoder.decode(new Uint8Array(bytes));
// 逐字拆开：只保留落在基本汉字区的字符
const chars = [...decoded];
console.log(`   区大小 ${((GBK_END[0] - GBK_START[0] + 1) * CHARS_PER_ROW)} 个码位，解出 ${chars.length} 个字符`);

console.log('== 2/4 定位声母边界 ==');
const initials = new Array(chars.length).fill(' ');
let previousIndex = -1;

for (const [initial, boundaryChar] of BOUNDARIES) {
  const index = chars.indexOf(boundaryChar);
  if (index === -1) {
    console.error(`   找不到边界字「${boundaryChar}」（声母 ${initial}），GBK 解码结果与预期不符`);
    process.exit(1);
  }
  if (index <= previousIndex) {
    console.error(`   边界字「${boundaryChar}」（${initial}）的位置 ${index} 没有前进（上一个 ${previousIndex}）`);
    process.exit(1);
  }
  previousIndex = index;
  console.log(`   ${initial} ← ${boundaryChar} @ ${index}`);
}

// 按边界填声母：第 i 个边界到下一个边界之前都是该声母
for (let i = 0; i < BOUNDARIES.length; i += 1) {
  const [initial, boundaryChar] = BOUNDARIES[i];
  const start = chars.indexOf(boundaryChar);
  const end = i + 1 < BOUNDARIES.length ? chars.indexOf(BOUNDARIES[i + 1][1]) : chars.length;
  for (let index = start; index < end; index += 1) initials[index] = initial;
}

const covered = initials.filter((value) => value !== ' ').length;
console.log(`   覆盖 ${covered}/${chars.length} 字（${((covered / chars.length) * 100).toFixed(1)}%）`);

console.log('== 3/4 抽查已知字的声母 ==');
/**
 * [字/词, 期望声母]。
 *
 * 这些是确定的，错了就说明边界表有问题。刻意只放**没有多音字歧义**的词
 * （多音字的另一读音由 `src/core/pinyin.ts` 的变体表处理，不在这里验）。
 */
const SAMPLES = [
  ['青花瓷', 'qhc'],
  ['周杰伦', 'zjl'],
  ['我很忙', 'whm'],
  ['北京', 'bj'],
  ['苏晚晴', 'swq'],
  ['林间清响', 'ljqx'],
  ['雾岛听风', 'wdtf'],
  ['深海备忘录', 'shbwl'],
  ['晨光练习曲', 'cglxq'],
  ['夏日回声', 'xrhs'],
  ['雨落青瓦', 'ylqw'],
  ['远方来信', 'yflx'],
  ['午后三点', 'whsd'],
  ['蝉鸣渐起', 'cmjq'],
  ['汽水与晚风', 'qsywf'],
  ['天台上的云', 'ttsdy'],
  ['旧单车', 'jdc'],
  ['夏天没有结束', 'xtmyjs'],
  ['回声', 'hs'],
  ['瓦上雨', 'wsy'],
  ['巷口', 'xk'],
  ['一盏灯', 'yzd'],
  ['寄往北方的信', 'jwbfdx'],
  ['车站', 'cz'],
  ['沿途', 'yt'],
  ['潮汐线', 'cxx'],
  ['未寄出的一页', 'wjcdyy'],
  ['三点零七分', 'sdlqf'],
  ['打盹', 'd'],
  ['玻璃窗上的光斑', 'blcsdgb'],
  ['慢下来', 'mxl'],
  ['水压', 'sy'],
  ['蓝', 'l'],
  ['晨光', 'cg'],
  // 逐个声母各来一个，保证 23 个区间都被抽查到
  ['啊', 'a'],
  ['芭', 'b'],
  ['擦', 'c'],
  ['搭', 'd'],
  ['蛾', 'e'],
  ['发', 'f'],
  ['噶', 'g'],
  ['哈', 'h'],
  ['击', 'j'],
  ['喀', 'k'],
  ['垃', 'l'],
  ['妈', 'm'],
  ['拿', 'n'],
  ['哦', 'o'],
  ['啪', 'p'],
  ['期', 'q'],
  ['然', 'r'],
  ['撒', 's'],
  ['塌', 't'],
  ['挖', 'w'],
  ['昔', 'x'],
  ['压', 'y'],
  ['匝', 'z'],
];

const charToInitial = new Map();
for (let index = 0; index < chars.length; index += 1) charToInitial.set(chars[index], initials[index]);

function initialsOf(text) {
  return [...text].map((char) => charToInitial.get(char) ?? '').join('');
}

let failures = 0;
for (const [text, expected] of SAMPLES) {
  const actual = initialsOf(text);
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✓' : '✗'} ${text.padEnd(8)} ${actual}${ok ? '' : `（期望 ${expected}）`}`);
}
if (failures > 0) {
  console.error(`\n抽查失败 ${failures} 项，说明边界表不准，先修边界再生成。`);
  process.exit(1);
}

console.log('== 4/4 写出表 ==');
const CHARS = chars.join('');
const INITIALS = initials.join('');

const file = `/**
 * 拼音声母表（**自动生成，不要手改**）。
 *
 * 生成命令：node scripts/make-pinyin-initials.mjs
 * 原理：GB2312 一级汉字区（0xB0A1–0xD7F9）按拼音顺序排列，所以知道每个声母区间的首字，
 * 就能靠位置推出区间内每个字的声母——不需要任何拼音词库。生成脚本里带抽查，
 * 边界表不准会直接失败，不会把错表写进仓库。
 *
 * 存成两个等长字符串是为了体积：${chars.length} 个字只占 ${((CHARS.length * 3 + INITIALS.length) / 1024).toFixed(1)}KB 源码，
 * 运行时由 pinyin.ts 建一张 Map 做 O(1) 查询。
 *
 * 已知限制：多音字只取 GB2312 排序所依据的那个读音（如「长」记作 c），
 * 少数常用多音字的另一读音由 pinyin.ts 的变体表兜住。
 */

/** 按 GB2312 顺序排列的汉字。 */
export const PINYIN_TABLE_CHARS = '${CHARS}';

/** 与 CHARS 逐位对应的声母；无拼音的字为空格。 */
export const PINYIN_TABLE_INITIALS = '${INITIALS}';
`;

if (existsSync(target)) {
  const previous = readFileSync(target, 'utf8');
  if (previous === file) {
    console.log(`   ${path.relative(root, target)} 内容未变，跳过写入`);
    process.exit(0);
  }
}
writeFileSync(target, file);
console.log(
  `   已写入 ${path.relative(root, target)}：${chars.length} 字，源码 ${(file.length / 1024).toFixed(1)}KB`,
);
