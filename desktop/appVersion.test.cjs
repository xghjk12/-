'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readAppVersion } = require('./appVersion.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qingyin-appversion-'));
}

test('读真实仓库根的 package.json：与根 package.json 声明的版本一致', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = readAppVersion(repoRoot);
  assert.equal(version, pkg.version);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test('读临时目录里手写的 package.json', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');
  assert.equal(readAppVersion(dir), '9.9.9');
});

test('版本号前后空白会被裁掉', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: ' 1.2.3 \n' }), 'utf8');
  assert.equal(readAppVersion(dir), '1.2.3');
});

test('package.json 不存在 → null（调用方回退 app.getVersion()）', () => {
  assert.equal(readAppVersion(tmpDir()), null);
});

test('package.json 损坏 → null', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{ 这不是 JSON', 'utf8');
  assert.equal(readAppVersion(dir), null);
});

test('version 缺失或不是字符串 → null', () => {
  const noVersion = tmpDir();
  fs.writeFileSync(path.join(noVersion, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
  assert.equal(readAppVersion(noVersion), null);

  const badType = tmpDir();
  fs.writeFileSync(path.join(badType, 'package.json'), JSON.stringify({ version: 123 }), 'utf8');
  assert.equal(readAppVersion(badType), null);

  const empty = tmpDir();
  fs.writeFileSync(path.join(empty, 'package.json'), JSON.stringify({ version: '   ' }), 'utf8');
  assert.equal(readAppVersion(empty), null);
});
