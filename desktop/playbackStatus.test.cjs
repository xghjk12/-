'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAYBACK_STATUS_UNKNOWN,
  normalizePlaybackStatus,
  sameMenuRelevantStatus,
  isShellCommandType,
  playPauseLabel,
} = require('./playbackStatus.js');

const NOW = () => '2026-10-22T03:00:00.000Z';

test('没收到过上报 → reported:false，三个播放项都该禁用', () => {
  assert.equal(PLAYBACK_STATUS_UNKNOWN.reported, false);
  assert.equal(PLAYBACK_STATUS_UNKNOWN.hasTrack, false);
  assert.equal(PLAYBACK_STATUS_UNKNOWN.playing, false);
  assert.deepEqual(normalizePlaybackStatus(undefined, NOW), { ...PLAYBACK_STATUS_UNKNOWN });
});

test('脏载荷（null / 数组 / 字符串）一律回落到"未知"，不抛', () => {
  for (const junk of [null, undefined, 42, 'playing', [], [{ playing: true }]]) {
    const status = normalizePlaybackStatus(junk, NOW);
    assert.equal(status.reported, false, `载荷 ${JSON.stringify(junk)} 不该被当成有效上报`);
    assert.equal(status.hasTrack, false);
  }
});

test('正常上报：字段原样规范化，reported 变 true，带上时间戳', () => {
  const status = normalizePlaybackStatus(
    { playing: true, hasTrack: true, currentIndex: 3, queueLength: 22 },
    NOW,
  );
  assert.deepEqual(status, {
    reported: true,
    playing: true,
    hasTrack: true,
    currentIndex: 3,
    queueLength: 22,
    reportedAt: '2026-10-22T03:00:00.000Z',
  });
});

test('布尔只认 ===true：字符串 "false"、1、"yes" 都不能让它变成播放中', () => {
  for (const junk of ['false', 1, 'yes', {}, []]) {
    assert.equal(normalizePlaybackStatus({ playing: junk, hasTrack: true }, NOW).playing, false);
  }
  assert.equal(normalizePlaybackStatus({ playing: true }, NOW).playing, true);
});

test('下标/长度的脏值回落成 null（负数、小数、字符串、缺字段）', () => {
  const status = normalizePlaybackStatus(
    { playing: false, currentIndex: -1, queueLength: '22', hasTrack: false },
    NOW,
  );
  assert.equal(status.currentIndex, null, '-1 是"没有当前曲目"，不是合法下标');
  assert.equal(status.queueLength, null, '字符串长度不能信');

  const fractional = normalizePlaybackStatus({ currentIndex: 1.7, queueLength: 2.2 }, NOW);
  assert.equal(fractional.currentIndex, null);
  assert.equal(fractional.queueLength, null);
});

test('渲染进程没给 hasTrack 时，从队列事实推出来（仍然是它报上来的事实，不是主进程猜播放状态）', () => {
  const derived = normalizePlaybackStatus({ playing: false, currentIndex: 0, queueLength: 4 }, NOW);
  assert.equal(derived.hasTrack, true);

  const emptyQueue = normalizePlaybackStatus({ playing: false, currentIndex: -1, queueLength: 0 }, NOW);
  assert.equal(emptyQueue.hasTrack, false, 'currentIndex 非法就不算有当前曲目');

  const noQueue = normalizePlaybackStatus({ playing: false }, NOW);
  assert.equal(noQueue.hasTrack, false);
});

test('渲染进程显式给了 hasTrack 就以它为准（布尔优先于推导）', () => {
  assert.equal(normalizePlaybackStatus({ hasTrack: true, queueLength: 0, currentIndex: -1 }, NOW).hasTrack, true);
  assert.equal(normalizePlaybackStatus({ hasTrack: false, queueLength: 9, currentIndex: 2 }, NOW).hasTrack, false);
});

test('菜单文案跟着播放状态走：播放中→暂停，否则→播放', () => {
  assert.equal(playPauseLabel({ playing: true }), '暂停');
  assert.equal(playPauseLabel({ playing: false }), '播放');
  assert.equal(playPauseLabel(null), '播放', '没有上报时按"播放"显示（此时菜单项本来就是禁用的）');
  assert.equal(playPauseLabel(PLAYBACK_STATUS_UNKNOWN), '播放');
});

test('命令白名单：只认三个类型，别的字符串/非字符串一律拒绝', () => {
  for (const ok of ['play-pause', 'prev', 'next']) {
    assert.equal(isShellCommandType(ok), true);
  }
  for (const bad of ['quit', 'PLAY-PAUSE', '', null, undefined, 42, {}, ['next']]) {
    assert.equal(isShellCommandType(bad), false, `${JSON.stringify(bad)} 不该被当成合法命令`);
  }
});

test('菜单相关切片比较：播放/当前曲目/队列长度变了才算变', () => {
  const base = { playing: true, hasTrack: true, currentIndex: 2, queueLength: 10 };
  assert.equal(sameMenuRelevantStatus(base, { ...base }), true);
  assert.equal(sameMenuRelevantStatus(base, { ...base, reportedAt: '别的时间' }), true, '时间戳不影响菜单');
  assert.equal(sameMenuRelevantStatus(base, { ...base, playing: false }), false);
  assert.equal(sameMenuRelevantStatus(base, { ...base, currentIndex: 3 }), false);
  assert.equal(sameMenuRelevantStatus(base, { ...base, queueLength: 11 }), false);
  assert.equal(sameMenuRelevantStatus(base, { ...base, hasTrack: false }), false);
});

test('菜单相关切片比较：任一侧缺失时只有"两边都缺"才算相同', () => {
  assert.equal(sameMenuRelevantStatus(null, null), true);
  assert.equal(sameMenuRelevantStatus(null, { playing: false }), false);
  assert.equal(sameMenuRelevantStatus({ playing: false }, undefined), false);
});

test('未知状态对象是冻结的（防止有人改它污染后续判断）', () => {
  assert.throws(() => {
    PLAYBACK_STATUS_UNKNOWN.playing = true;
  });
});
