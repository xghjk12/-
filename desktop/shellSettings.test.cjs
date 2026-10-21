'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  loadSettings,
  saveSettings,
  settingsPath,
  SETTINGS_FILENAME,
  DEFAULT_SETTINGS,
  normalizeToolPath,
  normalizeFolderPath,
} = require('./shellSettings.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-settings-'));
}

function full(overrides = {}) {
  // windowState 默认 null（t6）：首次启动没有窗口几何，用默认尺寸居中
  return { openAtLogin: false, lyricsToolPath: '', musicFolderPath: '', windowState: null, ...overrides };
}

test('目录里没有 settings.json（首次启动）→ 全部默认值', () => {
  const dir = tmpDir();
  assert.deepEqual(loadSettings(dir), full());
});

test('saveSettings 写文件，loadSettings 原样读回（含 t5 的两个路径键）', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true });
  assert.deepEqual(loadSettings(dir), full({ openAtLogin: true }));

  // 注意：这是部分更新——没传的 openAtLogin 保持 true（要换值就显式传）
  saveSettings(dir, { openAtLogin: false, lyricsToolPath: 'D:\\tools\\my-fill.ps1', musicFolderPath: 'D:\\音乐' });
  assert.deepEqual(loadSettings(dir), full({ lyricsToolPath: 'D:\\tools\\my-fill.ps1', musicFolderPath: 'D:\\音乐' }));
});

test('保存路径就是 <userData>/settings.json', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true });
  assert.equal(settingsPath(dir), path.join(dir, SETTINGS_FILENAME));
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

test('非严格布尔会被规范化成 false（只认 ===true）', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: 'yes' });
  assert.deepEqual(loadSettings(dir), full());

  saveSettings(dir, { openAtLogin: 1 });
  assert.deepEqual(loadSettings(dir), full());

  saveSettings(dir, null);
  assert.deepEqual(loadSettings(dir), full());
});

test('部分更新：只传一个键，其他键保持现值（t6 的 windowState 也靠这条语义）', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true, musicFolderPath: 'D:\\音乐' });
  // 只换工具脚本：自启与音乐目录都不能被误重置
  saveSettings(dir, { lyricsToolPath: 'D:\\tools\\my-fill.ps1' });
  assert.deepEqual(loadSettings(dir), full({
    openAtLogin: true,
    musicFolderPath: 'D:\\音乐',
    lyricsToolPath: 'D:\\tools\\my-fill.ps1',
  }));

  // 只切换自启：路径们保持
  saveSettings(dir, { openAtLogin: false });
  assert.deepEqual(loadSettings(dir), full({
    openAtLogin: false,
    musicFolderPath: 'D:\\音乐',
    lyricsToolPath: 'D:\\tools\\my-fill.ps1',
  }));
});

test('路径规范化：相对路径 / 非字符串 / 空白 → 空串（存目录只认绝对路径）', () => {
  assert.equal(normalizeFolderPath('D:\\音乐'), 'D:\\音乐');
  assert.equal(normalizeFolderPath('  D:\\音乐  '), 'D:\\音乐'); // 去首尾空白
  assert.equal(normalizeFolderPath(''), '');
  assert.equal(normalizeFolderPath('   '), '');
  assert.equal(normalizeFolderPath('音乐'), ''); // 相对路径不行
  assert.equal(normalizeFolderPath('music\\sub'), '');
  assert.equal(normalizeFolderPath(123), '');
  assert.equal(normalizeFolderPath(null), '');
  assert.equal(normalizeFolderPath(undefined), '');
  assert.equal(normalizeToolPath('D:\\t.ps1'), 'D:\\t.ps1');
  assert.equal(normalizeToolPath('t.ps1'), '');
});

test('坏路径读回来是空串而不是抛异常或带病存活', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ lyricsToolPath: 'relative.ps1', musicFolderPath: 42 }), 'utf8');
  assert.deepEqual(loadSettings(dir), full());
});

test('未知键不落盘（schema 显式四键，多余的丢弃）', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true, somethingElse: 'x' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(raw, { openAtLogin: true, lyricsToolPath: '', musicFolderPath: '', windowState: null });
});

test('settings.json 损坏 → 默认值，不抛异常', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ 截断的 JSON', 'utf8');
  assert.deepEqual(loadSettings(dir), full());
});

test('settings.json 是数组/字符串等非对象 → 默认值', () => {
  const dirArr = tmpDir();
  fs.writeFileSync(path.join(dirArr, 'settings.json'), '[1,2]', 'utf8');
  assert.deepEqual(loadSettings(dirArr), full());

  const dirStr = tmpDir();
  fs.writeFileSync(path.join(dirStr, 'settings.json'), '"hello"', 'utf8');
  assert.deepEqual(loadSettings(dirStr), full());
});

test('saveSettings 覆盖旧值且不留临时文件', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true });
  saveSettings(dir, { openAtLogin: false });
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['settings.json']);
});

test('saveSettings 连目标目录都不存在也能建（recursive）', () => {
  const dir = path.join(tmpDir(), 'nested', 'deeper');
  saveSettings(dir, { openAtLogin: true });
  assert.deepEqual(loadSettings(dir), full({ openAtLogin: true }));
});

test('默认值对象是冻结的（防止测试/调用方改默认坑下一个用户）', () => {
  assert.throws(() => {
    DEFAULT_SETTINGS.openAtLogin = true;
  });
});

// ---------------------------------------------------------------- t6：windowState

test('旧存档（t6 之前写的，没有 windowState 键）→ 读成 null，不抛', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ openAtLogin: true, lyricsToolPath: '', musicFolderPath: 'D:\\音乐' }),
    'utf8',
  );
  assert.deepEqual(loadSettings(dir), full({ openAtLogin: true, musicFolderPath: 'D:\\音乐' }));
  assert.equal(loadSettings(dir).windowState, null);
});

test('windowState 往返：存进去什么样，读回来什么样', () => {
  const dir = tmpDir();
  const state = { x: 120, y: 80, width: 1280, height: 860, maximized: false };
  saveSettings(dir, { windowState: state });
  assert.deepEqual(loadSettings(dir), full({ windowState: state }));

  saveSettings(dir, { windowState: { ...state, maximized: true } });
  assert.equal(loadSettings(dir).windowState.maximized, true);
});

test('windowState 结构不合法 → 整个丢成 null（不留半合法的几何）', () => {
  const dir = tmpDir();
  for (const junk of [{ x: 0, y: 0 }, { x: 0, y: 0, width: 10, height: 800 }, 'nope', 42, [], { x: 0, y: 0, width: '1200', height: 800 }]) {
    saveSettings(dir, { windowState: junk });
    assert.equal(loadSettings(dir).windowState, null, `${JSON.stringify(junk)} 应该被判为不合法`);
  }
});

test('windowState 落盘时坐标取整、maximized 只认 true', () => {
  const dir = tmpDir();
  saveSettings(dir, { windowState: { x: 100.6, y: 79.2, width: 1200.4, height: 800, maximized: 'yes' } });
  assert.deepEqual(loadSettings(dir).windowState, { x: 101, y: 79, width: 1200, height: 800, maximized: false });
});

test('部分更新：只传 windowState 不动其他键，只传别的键也不清掉 windowState', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true, musicFolderPath: 'D:\\音乐', lyricsToolPath: 'D:\\t.ps1' });
  const state = { x: 10, y: 20, width: 1000, height: 700, maximized: false };

  // t6 的防抖写盘只传这一个键：三个既有键必须原样保留
  saveSettings(dir, { windowState: state });
  assert.deepEqual(loadSettings(dir), full({
    openAtLogin: true,
    musicFolderPath: 'D:\\音乐',
    lyricsToolPath: 'D:\\t.ps1',
    windowState: state,
  }));

  // 反过来：切自启开关不能把窗口几何冲掉
  saveSettings(dir, { openAtLogin: false });
  assert.deepEqual(loadSettings(dir).windowState, state);
});

test('显式传 windowState: null 可以清掉（"忘掉上次的位置"）', () => {
  const dir = tmpDir();
  saveSettings(dir, { windowState: { x: 10, y: 20, width: 1000, height: 700, maximized: true } });
  saveSettings(dir, { windowState: null });
  assert.equal(loadSettings(dir).windowState, null);
});

test('windowState 不会被存档里的多余字段带脏（只认五个键）', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ windowState: { x: 5, y: 6, width: 1000, height: 700, maximized: false, evil: 'rm -rf' } }),
    'utf8',
  );
  assert.deepEqual(loadSettings(dir).windowState, { x: 5, y: 6, width: 1000, height: 700, maximized: false });
});
