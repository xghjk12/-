'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadSettings, saveSettings, settingsPath, SETTINGS_FILENAME, DEFAULT_SETTINGS } = require('./shellSettings.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-settings-'));
}

test('目录里没有 settings.json（首次启动）→ 默认值 openAtLogin:false', () => {
  const dir = tmpDir();
  assert.deepEqual(loadSettings(dir), { openAtLogin: false });
});

test('saveSettings 写文件，loadSettings 原样读回', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true });
  assert.deepEqual(loadSettings(dir), { openAtLogin: true });

  saveSettings(dir, { openAtLogin: false });
  assert.deepEqual(loadSettings(dir), { openAtLogin: false });
});

test('保存路径就是 <userData>/settings.json', () => {
  const dir = tmpDir();
  assert.equal(settingsPath(dir), path.join(dir, SETTINGS_FILENAME));
  saveSettings(dir, { openAtLogin: true });
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

test('非严格布尔会被规范化成 false（只认 ===true）', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: 'yes' });
  assert.deepEqual(loadSettings(dir), { openAtLogin: false });

  saveSettings(dir, { openAtLogin: 1 });
  assert.deepEqual(loadSettings(dir), { openAtLogin: false });

  saveSettings(dir, null);
  assert.deepEqual(loadSettings(dir), { openAtLogin: false });
});

test('未知键不落盘（schema 刻意只有一个键）', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true, somethingElse: 'x' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(raw, { openAtLogin: true });
});

test('settings.json 损坏 → 默认值，不抛异常', () => {
  const dir = tmpDir();
  saveSettings(dir, { openAtLogin: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ 截断的 JSON', 'utf8');
  assert.deepEqual(loadSettings(dir), { openAtLogin: false });
});

test('settings.json 是数组/字符串等非对象 → 默认值', () => {
  const dirArr = tmpDir();
  fs.writeFileSync(path.join(dirArr, 'settings.json'), '[1,2]', 'utf8');
  assert.deepEqual(loadSettings(dirArr), { openAtLogin: false });

  const dirStr = tmpDir();
  fs.writeFileSync(path.join(dirStr, 'settings.json'), '"hello"', 'utf8');
  assert.deepEqual(loadSettings(dirStr), { openAtLogin: false });
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
  assert.deepEqual(loadSettings(dir), { openAtLogin: true });
});

test('默认值对象是冻结的（防止测试/调用方改默认坑下一个用户）', () => {
  assert.throws(() => {
    DEFAULT_SETTINGS.openAtLogin = true;
  });
});
