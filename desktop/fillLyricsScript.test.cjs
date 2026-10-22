'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

/**
 * 内置补歌词脚本（`desktop/tools/fill-lyrics.ps1`）的回归。
 *
 * 这条测试的存在理由：这个脚本曾经**连跑都跑不起来**，而当时没有任何自动化
 * 能发现——E2E 用的是假工具（`fake-fill-lyrics.ps1`），真脚本只在人工清单里。
 * 上线后用户点「补歌词」直接看到"失败（退出码 1）"，两个原因：
 *   1. 脚本注释写着"在工具根目录跑"，代码却没切目录 → `No module named src.main`；
 *   2. 顶部 `$ErrorActionPreference='Stop'` 撞上 LyricFlow 写 stderr 的日志
 *      → PowerShell 把第一条日志当终止错误，脚本刚启动就退出 1。
 *
 * 现在用两个**不联网**的模式把它钉住：
 *   - `-Preflight`：能不能 import 到 `src.main`（cwd 正确性的最小检查）
 *   - `-SelfTest`：拿空目录完整跑一轮 LyricFlow（0 首 → 不发网络请求），
 *     能同时覆盖 cwd、stderr 处理与退出码传导。
 *
 * 依赖 `artifacts/lyricflow`（gitignore，不在仓库里）——没装就跳过，
 * 不能让新克隆的仓库因为"外部工具没装"而红。
 */

const desktopDir = __dirname;
const repoRoot = path.join(desktopDir, '..');
const script = path.join(desktopDir, 'tools', 'fill-lyrics.ps1');
const venvPython = path.join(repoRoot, 'artifacts', 'lyricflow', '.venv', 'Scripts', 'python.exe');

function runScript(args) {
  return spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 120_000,
  });
}

test('脚本文件存在且带 BOM（powershell 5.1 的硬要求）', () => {
  const buffer = fs.readFileSync(script);
  assert.equal(buffer[0], 0xef, '缺 UTF-8 BOM');
  assert.equal(buffer[1], 0xbb);
  assert.equal(buffer[2], 0xbf);
});

test('-Preflight：能 import 到 src.main（cwd 正确）', (t) => {
  if (!fs.existsSync(venvPython)) {
    t.skip('artifacts/lyricflow 未安装（外部工具不在仓库里）');
    return;
  }
  const result = runScript(['-Preflight']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /PREFLIGHT-OK/);
});

test('-SelfTest：空曲库完整跑一轮，退出 0 且没有模块/编码错误', (t) => {
  if (!fs.existsSync(venvPython)) {
    t.skip('artifacts/lyricflow 未安装（外部工具不在仓库里）');
    return;
  }
  const result = runScript(['-SelfTest']);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, `期望退出 0，实际 ${result.status}。输出：${output.slice(-800)}`);
  assert.match(result.stdout, /SELFTEST-MUSIC /);
  // 空目录 → 扫 0 首 → 不发网络请求
  assert.match(output, /Scanned:\s+0 files/);
  // 退出码要真的传到父进程（曾经被 Stop 截断在半路）
  assert.match(result.stdout, /LYRICFLOW-EXIT 0/);
  // 这两类是历史故障的标志，再出现就是回归
  assert.doesNotMatch(output, /No module named/);
  assert.doesNotMatch(output, /\uFFFD/);
});
