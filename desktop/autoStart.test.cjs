'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  buildRunCommand,
  parseRegExportValue,
  readLoginItemCommand,
  enableLoginItem,
  disableLoginItem,
  RUN_KEY,
  APPROVED_KEY,
} = require('./autoStart.js');

// ---- buildRunCommand（纯函数） ----

test('buildRunCommand：exe 恒定加引号，ASCII 参数不加', () => {
  assert.equal(
    buildRunCommand('C:\\apps\\player.exe', ['--no-sandbox']),
    '"C:\\apps\\player.exe" --no-sandbox',
  );
});

test('buildRunCommand：未打包形态 = exe + 应用目录 + --no-sandbox（目录含中文要加引号）', () => {
  const command = buildRunCommand('D:\\node_modules\\electron.exe', ['D:\\轻音播放\\desktop', '--no-sandbox']);
  assert.equal(command, '"D:\\node_modules\\electron.exe" "D:\\轻音播放\\desktop" --no-sandbox');
});

test('buildRunCommand：含空格的参数加引号', () => {
  assert.equal(
    buildRunCommand('C:\\a.exe', ['D:\\my music\\folder']),
    '"C:\\a.exe" "D:\\my music\\folder"',
  );
});

test('buildRunCommand：args 缺省 = 只有 exe', () => {
  assert.equal(buildRunCommand('C:\\a.exe', undefined), '"C:\\a.exe"');
});

// ---- parseRegExportValue（纯函数） ----

test('parseRegExportValue：标准 .reg 文本提取 REG_SZ 数据', () => {
  const text =
    'Windows Registry Editor Version 5.00\r\n\r\n' +
    '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]\r\n' +
    '"Steam"="D:\\\\steam\\\\steam.exe -silent"\r\n' +
    '"qingyin-player"="\\"D:\\\\node_modules\\\\electron.exe\\" --no-sandbox"\r\n';
  assert.equal(
    parseRegExportValue(text, 'qingyin-player'),
    '"D:\\node_modules\\electron.exe" --no-sandbox',
  );
  assert.equal(parseRegExportValue(text, 'Steam'), 'D:\\steam\\steam.exe -silent');
});

test('parseRegExportValue：值不存在 → null', () => {
  const text = '[HKEY_CURRENT_USER\\...]\r\n"Steam"="x"\r\n';
  assert.equal(parseRegExportValue(text, 'qingyin-player'), null);
});

test('parseRegExportValue：转义还原（\\ → \，\" → "）', () => {
  // .reg 数据 `a\\b\"c\"d` 是命令 `a\b"c"d` 的编码形态
  const text = '"n"="a\\\\b\\"c\\"d"';
  assert.equal(parseRegExportValue(text, 'n'), 'a\\b"c"d');
});

test('parseRegExportValue：带引号 exe 路径的完整命令（真实形态）', () => {
  // 命令 "D:\x.exe" --run 的 .reg 编码
  const text = '"n"="\\\"D:\\\\x.exe\\\" --run"';
  assert.equal(parseRegExportValue(text, 'n'), '"D:\\x.exe" --run');
});

test('parseRegExportValue：hex: 形态（非 REG_SZ）→ null，防误读', () => {
  const text = '"n"=hex:02,00,00,00';
  assert.equal(parseRegExportValue(text, 'n'), null);
});

test('parseRegExportValue：空文本 → null', () => {
  assert.equal(parseRegExportValue('', 'n'), null);
  assert.equal(parseRegExportValue(null, 'n'), null);
});

// ---- 常量与注册表真机读写（Windows 专属，真写真删真读） ----

const IS_WIN = process.platform === 'win32';
const NAME = `qingyin-selftest-${process.pid}`;

test('RUN_KEY / APPROVED_KEY 指向 HKCU 的标准位置', () => {
  assert.equal(RUN_KEY, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.equal(
    APPROVED_KEY,
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  );
});

test('enable → read → disable → read 全链路（真注册表）', { skip: !IS_WIN }, async () => {
  const exePath = process.execPath; // node.exe，无副作用（复位即删）
  const args = ['--flag'];
  const name = NAME;

  // 起点干净
  await disableLoginItem({ name });
  assert.equal(await readLoginItemCommand({ name }), null);

  // 启用：命令应原样写进 Run 并能读回（reg export 路径，无代码页问题）
  const enableRes = await enableLoginItem({ exePath, args, name });
  assert.equal(enableRes.ok, true, `reg add 失败：${JSON.stringify(enableRes)}`);
  assert.equal(enableRes.approved, true);
  const readBack = await readLoginItemCommand({ name });
  assert.equal(readBack, buildRunCommand(exePath, args));

  // 禁用：值消失
  const disableRes = await disableLoginItem({ name });
  assert.equal(disableRes.ok, true);
  assert.equal(await readLoginItemCommand({ name }), null);

  // 重复禁用（值已不存在）不应报错
  await disableLoginItem({ name });
});

test('enableLoginItem 幂等（重复 enable 命令不变）', { skip: !IS_WIN }, async () => {
  const exePath = process.execPath;
  const args = ['--a', '--b'];
  const name = NAME;
  await enableLoginItem({ exePath, args, name });
  await enableLoginItem({ exePath, args, name });
  assert.equal(await readLoginItemCommand({ name }), buildRunCommand(exePath, args));
  await disableLoginItem({ name });
});
