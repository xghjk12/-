'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

/**
 * 源码编码纪律：`desktop/` 下的 PowerShell 脚本**必须带 UTF-8 BOM**。
 *
 * 为什么值得一条测试：本机的 `powershell.exe` 是 Windows PowerShell 5.1，
 * 它对没有 BOM 的文件按 **ANSI/OEM 代码页** 解析。脚本里有中文（注释、提示、
 * 正则），一旦缺 BOM，中文变乱码，轻则提示不可读，重则**直接语法错误**。
 *
 * 这是真实踩过的坑：用编辑器（写 UTF-8 无 BOM）改了一下 fill-lyrics.ps1，
 * 脚本立刻报 `Unexpected token`，而 git diff 看起来只有几行代码变化——
 * 因为编码差异不在文本 diff 里。
 *
 * 另一个痕迹是 U+FFFD（替换字符）：它说明某次读写把字节弄丢了，
 * 这种文件即使有 BOM 也已经损坏。
 */

const desktopDir = __dirname;

/** 递归收集 .ps1（排除 node_modules / artifacts）。 */
function collectScripts(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'artifacts') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectScripts(full, acc);
    else if (entry.name.endsWith('.ps1')) acc.push(full);
  }
  return acc;
}

test('desktop 下的 .ps1 全部带 UTF-8 BOM（powershell 5.1 否则按 ANSI 解）', () => {
  const scripts = collectScripts(desktopDir);
  assert.ok(scripts.length >= 5, `应该能找到多个 .ps1，实际 ${scripts.length}`);

  for (const file of scripts) {
    const buffer = fs.readFileSync(file);
    const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    assert.equal(
      hasBom,
      true,
      `${path.relative(desktopDir, file)} 缺 UTF-8 BOM：Windows PowerShell 5.1 会按 ANSI 解析，中文会乱码甚至直接语法错误`,
    );
  }
});

test('.ps1 里没有 U+FFFD（编码损坏痕迹）', () => {
  for (const file of collectScripts(desktopDir)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(
      text.includes('\uFFFD'),
      false,
      `${path.relative(desktopDir, file)} 含替换字符 U+FFFD：某次读写把字节弄丢了`,
    );
  }
});
