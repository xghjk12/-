/**
 * 架构纪律：`src/core/` 里不允许出现平台 API（技术方案 3.2）。
 *
 * 这条约束是整个方案的地基——它保证"音频与 DOM 之外的逻辑"可以 100% 单测，
 * 也让将来上 Electron 或换 UI 框架不用重写业务逻辑。
 *
 * 用测试强制，而不是靠自觉：一旦有人在 core 里 `import 'node:fs'` 或碰 `window`，
 * 这个测试就会失败。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreDir = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bwindow\b/, label: 'window' },
  { pattern: /\bdocument\b/, label: 'document' },
  { pattern: /\bnavigator\b/, label: 'navigator' },
  { pattern: /\bindexedDB\b/, label: 'indexedDB' },
  { pattern: /\bFileSystemDirectoryHandle\b/, label: 'FileSystemDirectoryHandle' },
  { pattern: /\bHTMLAudioElement\b/, label: 'HTMLAudioElement' },
  { pattern: /['"]node:[a-z0-9_/.-]+['"]/, label: "import 'node:...'" },
  { pattern: /\brequire\s*\(/, label: 'require(' },
];

/**
 * 去掉注释再检查：注释里出现"window"是在解释纪律本身，不是违规。
 * （不处理正则字面量里的 `//`，core 里也没有这种写法。）
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('core 层不依赖平台', () => {
  it('src/core 下的非测试文件不出现任何平台 API', async () => {
    const files = (await readdir(coreDir)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    expect(files.length, 'core 目录下应该有实现文件').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(path.join(coreDir, file), 'utf8'));
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(code)) violations.push(`src/core/${file} 命中 ${label}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('core 的导入只指向 core 自己', async () => {
    const files = (await readdir(coreDir)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );

    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(path.join(coreDir, file), 'utf8'));
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        // 只允许相对导入，且必须落在 core 内部（platform / ui 都不能被 core 反向依赖）
        const isRelative = specifier.startsWith('./');
        if (!isRelative || specifier.includes('../')) {
          violations.push(`src/core/${file} 导入了 ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
