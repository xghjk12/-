'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTrayMenuTemplate } = require('./trayMenu.js');

function templateOf(overrides = {}) {
  return buildTrayMenuTemplate({
    windowVisible: true,
    openAtLogin: false,
    version: '0.1.0',
    updateAvailable: null,
    ...overrides,
  });
}

function byId(template, id) {
  return template.find((item) => item.id === id);
}

test('模板结构：切换窗口 / 自启 / 更新位 / 退出，之间用分隔条隔开', () => {
  const template = templateOf();
  const ids = template.filter((item) => item.id).map((item) => item.id);
  assert.deepEqual(ids, ['toggle-window', 'open-at-login', 'check-update', 'quit']);
  assert.equal(template.filter((item) => item.type === 'separator').length, 3);
});

test('toggle-window 文案随窗口可见状态换向', () => {
  assert.equal(byId(templateOf({ windowVisible: true }), 'toggle-window').label, '隐藏窗口');
  assert.equal(byId(templateOf({ windowVisible: false }), 'toggle-window').label, '显示窗口');
});

test('open-at-login 是 checkbox，勾选态跟随状态', () => {
  const off = byId(templateOf({ openAtLogin: false }), 'open-at-login');
  assert.equal(off.type, 'checkbox');
  assert.equal(off.checked, false);

  const on = byId(templateOf({ openAtLogin: true }), 'open-at-login');
  assert.equal(on.type, 'checkbox');
  assert.equal(on.checked, true);
});

test('更新提示位：本期没有更新源 → 禁用 + 文案带当前版本号', () => {
  const item = byId(templateOf({ updateAvailable: null }), 'check-update');
  assert.equal(item.enabled, false);
  assert.match(item.label, /v0\.1\.0/);
  assert.match(item.label, /检查更新/);
});

test('更新提示位：有挂起更新 → 换文案（为将来接更新源固化行为）', () => {
  const item = byId(templateOf({ updateAvailable: '0.2.0' }), 'check-update');
  assert.equal(item.label, '有新版本 v0.2.0 可用');
});

test('quit 永远存在且可用', () => {
  const item = byId(templateOf(), 'quit');
  assert.equal(item.label, '退出');
  assert.notEqual(item.enabled, false);
});

test('模板不含 click（接线是 tray.js 的职责，模板是纯数据）', () => {
  for (const item of templateOf()) {
    assert.equal(item.click, undefined);
  }
});
