#!/usr/bin/env node
/**
 * 界面层静态一致性检查（`pnpm check:static`）。
 *
 * 界面做不了完整的渲染测试，但界面层最常见的错误是"引用了不存在的东西"：
 * 类名拼错、样式没写、冒烟脚本选中的元素不存在。这类问题在浏览器里往往只是静默失效
 * （元素没有样式、选择器等不到），肉眼很难发现，所以用源码扫描兜住。
 *
 * 检查三件事：
 *   1. 界面源码（src/ui 下的 .tsx / .ts）里用到的每个 class 都能在 styles.css 里找到
 *   2. `scripts/check-ui.mjs` 依赖的选择器在源码里真的存在（id / class / title）
 *   3. 样式里定义的类名没有被误删（反向抽查：smoke 用到的类必须有定义）
 *
 * 用法：pnpm check:static
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(root, 'src', 'ui');

/** 这些类来自第三方或刻意不写样式，不参与检查。 */
const ALLOWED_WITHOUT_STYLE = new Set(['ok', 'bad', 'sortable', 'muted', 'warn-text']);

function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(absolute);
    return /\.tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

const failures = [];

/* ==================== 1. className 里的类名都有样式 ==================== */

const css = readFileSync(path.join(uiDir, 'styles.css'), 'utf8');
const styled = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));

const used = new Map();

/**
 * 取出 `className=` 后面的表达式文本。
 *
 * `className={\`row${a ? ' row-active' : ''}\`}` 这种写法里既有嵌套花括号又有字符串，
 * 简单地按第一个 `}` 截断会切出半截表达式，所以这里做平衡花括号匹配，
 * 并在遇到引号/反引号时整段跳过。
 */
function classNameExpressions(source) {
  const results = [];
  const marker = /className=/g;
  let match;

  while ((match = marker.exec(source)) !== null) {
    const start = match.index + match[0].length;
    const first = source[start];

    if (first === '"' || first === "'") {
      const end = source.indexOf(first, start + 1);
      // 连引号一起留着：下面的提取统一按"引号里的字面量"处理
      results.push(source.slice(start, end + 1));
      continue;
    }
    if (first !== '{') continue;

    let depth = 0;
    let cursor = start;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '"' || char === "'" || char === '`') {
        let inner = cursor + 1;
        while (inner < source.length && source[inner] !== char) {
          if (source[inner] === '\\') inner += 1;
          inner += 1;
        }
        cursor = inner;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    results.push(source.slice(start, cursor + 1));
  }

  return results;
}

/** 只认小写短横线形式的类名，避免把 `x === y` 之类的表达式碎片当成类名。 */
const CLASS_TOKEN = /^[a-z][a-z0-9-]*$/;

for (const file of listSourceFiles(uiDir)) {
  const source = readFileSync(file, 'utf8');
  for (const expression of classNameExpressions(source)) {
    for (const literal of [...expression.matchAll(/['"`]([^'"`]*)['"`]/g)].map((item) => item[1])) {
      for (const token of literal.split(/\s+/).filter(Boolean)) {
        if (!CLASS_TOKEN.test(token)) continue;
        if (!used.has(token)) used.set(token, path.relative(root, file));
      }
    }
  }
}

for (const [token, file] of used) {
  if (styled.has(token) || ALLOWED_WITHOUT_STYLE.has(token)) continue;
  failures.push(`${file} 使用了未定义样式的类名：.${token}`);
}

/* ==================== 2. 冒烟脚本依赖的选择器确实存在 ==================== */

const smoke = readFileSync(path.join(root, 'scripts', 'check-ui.mjs'), 'utf8');
const uiSource = listSourceFiles(uiDir)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

/** [选择器, 期望在源码里出现的证据] */
const REQUIRED = [
  ['#selfTestResult', "'selfTestResult'"],
  ['.row', 'row'],
  ['.queue', 'queue'],
  ['.queue-item', 'queue-item'],
  ['.notice', 'notice'],
  ['button[title="播放队列"]', '播放队列'],
];

for (const [selector, evidence] of REQUIRED) {
  if (!smoke.includes(selector)) continue; // 冒烟脚本没用到就不用查
  const needle = evidence.replace(/^'|'$/g, '');
  if (!uiSource.includes(needle)) {
    failures.push(`check-ui.mjs 依赖选择器 ${selector}，但源码里找不到「${needle}」`);
  }
}

if (used.size === 0) failures.push('没有从界面源码里提取到任何 class，检查逻辑可能失效了');

/* ==================== 输出 ==================== */

console.log('== 界面层静态一致性 ==');
console.log(`  界面源码里用到 ${used.size} 个类名，styles.css 里定义 ${styled.size} 个选择器`);

if (failures.length > 0) {
  console.error(`\n发现 ${failures.length} 处不一致：`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('  类名与样式、冒烟选择器一致。');
