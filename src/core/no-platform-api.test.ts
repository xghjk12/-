/**
 * 架构纪律：`src/core/` 里不允许出现平台 API（技术方案 3.2）。
 *
 * 这条约束是整个方案的地基——它保证"音频与 DOM 之外的逻辑"可以 100% 单测，
 * 也让将来上 Electron 或换 UI 框架不用重写业务逻辑。
 *
 * 用测试强制，而不是靠自觉：一旦有人在 core 里 `import 'node:fs'` 或碰 `window`，
 * 这个测试就会失败。
 *
 * 2026-10 加固（由一次只读审计发现）：原版只有 8 条正则、只扫顶层 `.ts`、只认 `from` 导入，
 * 漏掉了 `fetch` / `localStorage` / `Blob` / `Audio` / `process` / `globalThis` 等常见平台入口，
 * 也漏掉副作用导入与动态导入。现在补全，并且**给扫描规则本身加了自测**——
 * 否则规则写错了（比如正则拼错）也会"通过"，这种测试比没有更糟。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * 平台 API 名单。
 *
 * 注意大小写敏感与词边界：`\bFile\b` 不会误伤 `FileRef`，`\bBuffer\b` 不会误伤局部变量 `buffer`。
 * 故意**不禁** `URL`：`new URL(...)` 是标准同构全局，而且歌词模板校验正需要它。
 */
const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  // DOM / 浏览器
  { pattern: /\bwindow\b/, label: 'window' },
  { pattern: /\bdocument\b/, label: 'document' },
  { pattern: /\bnavigator\b/, label: 'navigator' },
  { pattern: /\blocalStorage\b/, label: 'localStorage' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage' },
  { pattern: /\bindexedDB\b/, label: 'indexedDB' },
  { pattern: /\bFileSystemDirectoryHandle\b/, label: 'FileSystemDirectoryHandle' },
  { pattern: /\bHTMLAudioElement\b/, label: 'HTMLAudioElement' },
  { pattern: /\bHTMLMediaElement\b/, label: 'HTMLMediaElement' },
  { pattern: /\bAudio\b/, label: 'Audio' },
  { pattern: /\brequestAnimationFrame\b/, label: 'requestAnimationFrame' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bfetch\b/, label: 'fetch' },
  { pattern: /\bBlob\b/, label: 'Blob' },
  { pattern: /\bFile\b/, label: 'File' },
  { pattern: /\bcreateObjectURL\b/, label: 'createObjectURL' },
  // 运行时 / Node
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\bBuffer\b/, label: 'Buffer' },
  { pattern: /\brequire\s*\(/, label: 'require(' },
  { pattern: /['"]node:[a-z0-9_/.-]+['"]/, label: "import 'node:...'" },
  // 间接取全局（core 里连这个都不该有：真需要就注入进来，像 LyricDecoder 那样）
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  { pattern: /\bself\b/, label: 'self' },
];

/**
 * 去掉注释再检查：注释里出现"window"是在解释纪律本身，不是违规。
 *
 * 已知局限（审计提出，暂不处理）：行内 `//` 出现在字符串字面量里时会截断该行后半段，
 * 可能造成假阴性；core 里目前没有这种写法，要更严谨得换成真正的词法分析。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/** 扫描一段代码里的平台 API，返回命中的标签（去重）。 */
function findApiViolations(code: string): string[] {
  const stripped = stripComments(code);
  const hits = FORBIDDEN.filter(({ pattern }) => pattern.test(stripped)).map(({ label }) => label);
  return [...new Set(hits)];
}

/** 收集所有导入说明符：`from '...'`、副作用 `import '...'`、动态 `import('...')`。 */
function findImportSpecifiers(code: string): string[] {
  const stripped = stripComments(code);
  const found: string[] = [];
  for (const match of stripped.matchAll(/from\s+['"]([^'"]+)['"]/g)) found.push(match[1]!);
  for (const match of stripped.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(match[1]!);
  for (const match of stripped.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]!);
  return [...new Set(found)];
}

/** 导入是否越界：core 只允许指向 core 内部的相对路径。 */
function isIllegalImport(specifier: string): boolean {
  return !specifier.startsWith('./') || specifier.includes('../');
}

/** 递归收集 core 下的实现文件（不含测试）。 */
async function collectSources(dir: string, prefix = ''): Promise<Array<{ rel: string; code: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sources: Array<{ rel: string; code: string }> = [];

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      sources.push(...(await collectSources(path.join(dir, entry.name), rel)));
      continue;
    }
    const isImplementation =
      entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts');
    if (isImplementation) {
      sources.push({ rel, code: await readFile(path.join(dir, entry.name), 'utf8') });
    }
  }

  return sources;
}

describe('core 层不依赖平台', () => {
  it('src/core 下的非测试文件不出现任何平台 API', async () => {
    const sources = await collectSources(coreDir);
    expect(sources.length, 'core 目录下应该有实现文件').toBeGreaterThan(0);

    const violations = sources.flatMap(({ rel, code }) =>
      findApiViolations(code).map((label) => `src/core/${rel} 命中 ${label}`),
    );

    expect(violations).toEqual([]);
  });

  it('core 的导入只指向 core 自己', async () => {
    const sources = await collectSources(coreDir);

    const violations = sources.flatMap(({ rel, code }) =>
      findImportSpecifiers(code)
        .filter(isIllegalImport)
        .map((specifier) => `src/core/${rel} 导入了 ${specifier}`),
    );

    expect(violations).toEqual([]);
  });
});

/**
 * 规则自测。
 *
 * 没有这一组，上面两条测试只能证明"当前代码干净"——规则写错了也照样绿。
 */
describe('扫描规则自身', () => {
  it('能抓到常见平台入口', () => {
    const samples: Array<[string, string]> = [
      ['const x = await fetch("/a")', 'fetch'],
      ['localStorage.setItem("k", "v")', 'localStorage'],
      ['const blob = new Blob([bytes])', 'Blob'],
      ['const file = new File([], "a.mp3")', 'File'],
      ['const el = new Audio()', 'Audio'],
      ['const p = process.env', 'process'],
      ['const b = Buffer.from(x)', 'Buffer'],
      ['window.dispatchEvent(e)', 'window'],
      ['requestAnimationFrame(tick)', 'requestAnimationFrame'],
      ['const t = (globalThis as any).TextDecoder', 'globalThis'],
      ['import fs from "node:fs"', "import 'node:...'"],
      ['const fs = require("fs")', 'require('],
    ];

    for (const [code, expected] of samples) {
      expect(findApiViolations(code), code).toContain(expected);
    }
  });

  it('不误报普通标识符与注释', () => {
    const samples = [
      'const path = track.path;',
      'const buffer = ""; buffer += "x";',
      'const AudioFileRef = { path: "a" };',
      'const FileRef: number = 1;',
      'const url = new URL("https://example.com");',
      '// 这里解释为什么不用 window，注释里出现 window 不算违规',
      '/* document 也只是说明文字 */',
      'export interface BlobLike { size: number }',
    ];

    for (const code of samples) {
      expect(findApiViolations(code), code).toEqual([]);
    }
  });

  it('注释会被剥掉，但代码不会被误伤', () => {
    expect(findApiViolations('// window.document\nconst a = 1;')).toEqual([]);
    expect(findApiViolations('const a = 1; // 注释里的 window\nwindow.x = 1;')).toContain('window');
    expect(stripComments('const url = "https://a.b/c"; // 尾巴')).toContain('https://a.b/c');
  });

  it('导入规则能抓到副作用导入与动态导入', () => {
    expect(findImportSpecifiers("import '../platform/x.js';")).toEqual(['../platform/x.js']);
    expect(findImportSpecifiers('const m = await import("../ui/x.js");')).toEqual(['../ui/x.js']);
    expect(findImportSpecifiers("import type { A } from '../platform/x.js';")).toEqual([
      '../platform/x.js',
    ]);
    expect(isIllegalImport('./queue.js')).toBe(false);
    expect(isIllegalImport('../platform/x.js')).toBe(true);
    expect(isIllegalImport('node:fs')).toBe(true);
    expect(isIllegalImport('react')).toBe(true);
  });

  it('递归扫描：子目录里的文件也在范围内', async () => {
    const sources = await collectSources(coreDir);
    // 顶层文件必须有，且每条路径都不带 core/ 前缀（rel 是相对 core 的）
    expect(sources.some(({ rel }) => rel === 'queue.ts')).toBe(true);
    expect(sources.every(({ rel }) => !rel.startsWith('/'))).toBe(true);
    expect(sources.some(({ rel }) => rel.endsWith('.test.ts'))).toBe(false);
  });
});
