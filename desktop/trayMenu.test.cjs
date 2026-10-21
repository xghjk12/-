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

test('模板结构：既有分组齐全，退出在最后（不断言精确全列表——t6 的播放项等他人项共存）', () => {
  const template = templateOf();
  const ids = template.filter((item) => item.id).map((item) => item.id);
  // t2/t5 之外允许别的任务往模板里加项（t6 的播放控制已经加进来了），
  // 这里只固化我们自己的不变式：必备 id 都在、有分隔条、quit 收尾
  for (const required of ['toggle-window', 'fill-lyrics', 'lyrics-music-folder', 'lyrics-tool-settings', 'open-at-login', 'check-update', 'quit']) {
    assert.ok(ids.includes(required), `缺少菜单项 ${required}`);
  }
  assert.equal(ids[ids.length - 1], 'quit', 'quit 必须是最后一项');
  assert.ok(template.filter((item) => item.type === 'separator').length >= 3, '分组分隔条不能少于 3 个');
  assert.deepEqual(ids, [...new Set(ids)], '菜单项 id 不能重复');
});

test('补歌词项：默认可点，running 时换文案且禁用', () => {
  const idle = byId(templateOf(), 'fill-lyrics');
  assert.equal(idle.label, '补歌词…');
  assert.notEqual(idle.enabled, false);

  const running = byId(templateOf({ lyricsToolStatus: 'running' }), 'fill-lyrics');
  assert.match(running.label, /运行中/);
  assert.equal(running.enabled, false);

  assert.match(byId(templateOf({ lyricsToolStatus: 'done' }), 'fill-lyrics').label, /上次成功/);
  assert.match(byId(templateOf({ lyricsToolStatus: 'failed' }), 'fill-lyrics').label, /上次失败/);
  // cancelled 是独立终态（t8）：文案「上次已取消」——不能带「失败」字眼
  const cancelled = byId(templateOf({ lyricsToolStatus: 'cancelled' }), 'fill-lyrics');
  assert.match(cancelled.label, /上次已取消/);
  assert.doesNotMatch(cancelled.label, /失败/, '取消是主动行为，托盘文案不许叫失败');
  assert.notEqual(cancelled.enabled, false, '取消后可以立刻再跑一轮');
});

test('补歌词的路径设置入口：两个菜单项都在且可点', () => {
  const folder = byId(templateOf(), 'lyrics-music-folder');
  assert.equal(folder.label, '指定音乐文件夹…');
  assert.notEqual(folder.enabled, false);
  const tool = byId(templateOf(), 'lyrics-tool-settings');
  assert.equal(tool.label, '选择补歌词工具…');
  assert.notEqual(tool.enabled, false);
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
