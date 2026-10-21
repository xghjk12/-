'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { trayTooltip, titleWithVersion } = require('./shellText.js');

test('trayTooltip：基础形态 = 应用名 + 版本号', () => {
  assert.equal(trayTooltip({ appName: '轻音播放', version: '0.1.0', updateAvailable: null }), '轻音播放 v0.1.0');
});

test('trayTooltip：挂起更新时加一行提示', () => {
  assert.equal(
    trayTooltip({ appName: '轻音播放', version: '0.1.0', updateAvailable: '0.2.0' }),
    '轻音播放 v0.1.0\n有新版本 v0.2.0 可用',
  );
});

test('titleWithVersion：默认页面标题补版本', () => {
  assert.equal(titleWithVersion('轻音播放', '0.1.0', '轻音播放'), '轻音播放 v0.1.0');
});

test('titleWithVersion：播放中的「歌名 - 轻音播放」也补在末尾', () => {
  assert.equal(titleWithVersion('青花瓷 - 轻音播放', '0.1.0', '轻音播放'), '青花瓷 - 轻音播放 v0.1.0');
});

test('titleWithVersion：已带版本号的不重复补（page-title-updated 会反复触发）', () => {
  const once = titleWithVersion('轻音播放', '0.1.0', '轻音播放');
  assert.equal(titleWithVersion(once, '0.1.0', '轻音播放'), once);
});

test('titleWithVersion：空标题/undefined/null → 兜底标题', () => {
  assert.equal(titleWithVersion('', '0.1.0', '轻音播放'), '轻音播放 v0.1.0');
  assert.equal(titleWithVersion(undefined, '0.1.0', '轻音播放'), '轻音播放 v0.1.0');
  assert.equal(titleWithVersion(null, '0.1.0', '轻音播放'), '轻音播放 v0.1.0');
});

test('titleWithVersion：只有空白的标题 → 兜底标题', () => {
  assert.equal(titleWithVersion('   ', '0.1.0', '轻音播放'), '轻音播放 v0.1.0');
});
