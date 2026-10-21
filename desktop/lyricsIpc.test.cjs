'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// lyricsIpc 顶层 require('electron')：普通 node 下拿到的是 exe 路径字符串，
// 解构出的 ipcMain 是 undefined——不防碍加载模块、测纯函数（install 才用它）。
const { resolveLyricsToolScript, musicFolderProblem } = require('./lyricsIpc.js');

const BUILT_IN = path.join(__dirname, 'tools', 'fill-lyrics.ps1');

function tmpFile(name = 'custom-tool.ps1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-lyrics-ipc-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'Write-Output ok\n', 'utf8');
  return file;
}

test('resolveLyricsToolScript：lyricsToolPath 为空 → 内置（正常路径，保持现状）', () => {
  for (const empty of ['', '   ', undefined, null, 42]) {
    const resolved = resolveLyricsToolScript({ lyricsToolPath: empty, builtInScriptPath: BUILT_IN });
    assert.equal(resolved.scriptPath, BUILT_IN, `空值 ${JSON.stringify(empty)} 应选内置`);
    assert.equal(resolved.error, undefined);
  }
});

test('resolveLyricsToolScript：自定义路径存在 → 用它（含首尾空白的容错）', () => {
  const custom = tmpFile();
  const resolved = resolveLyricsToolScript({
    lyricsToolPath: `  ${custom}  `,
    builtInScriptPath: BUILT_IN,
  });
  assert.equal(resolved.scriptPath, custom);
  assert.equal(resolved.error, undefined);
});

test('resolveLyricsToolScript：路径不存在 → 错误（含路径与改法），绝不返回内置', () => {
  const missing = path.join(os.tmpdir(), `no-such-tool-${Date.now()}.ps1`);
  assert.equal(fs.existsSync(missing), false, '前置：路径确实不存在');

  const resolved = resolveLyricsToolScript({ lyricsToolPath: missing, builtInScriptPath: BUILT_IN });

  // 核心断言（t9）：这是**错误**，不是静默回退
  assert.ok(resolved.error, '必须给出错误');
  assert.equal(resolved.scriptPath, undefined, '绝不给出 scriptPath（不许回退去跑内置）');
  assert.ok(resolved.error.includes(missing), `错误文案要含路径本身：${resolved.error}`);
  assert.ok(/选择补歌词工具/.test(resolved.error), '错误文案要告诉用户怎么改（重选工具）');
  assert.ok(/恢复内置脚本/.test(resolved.error), '错误文案要给出恢复内置的出路');
});

test('musicFolderProblem：目录 → null；文件 → 带路径的错误；不存在/为空 → null（走对话框）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-folder-check-'));
  const file = tmpFile('plain.mp3');

  assert.equal(musicFolderProblem(dir), null, '目录没问题');
  assert.equal(musicFolderProblem(file), `音乐文件夹不是目录：${file}（托盘 → 指定音乐文件夹… 可重选）`);
  assert.equal(musicFolderProblem(path.join(dir, '已删除')), null, '不存在 → 交给对话框重选，不算预检错误');
  assert.equal(musicFolderProblem(''), null, '空 → 对话框');
  assert.equal(musicFolderProblem(null), null);
});
