'use strict';

/**
 * 轻音播放 · core.js 单元测试
 * 运行：node --test demo/
 *
 * 覆盖范围：时间格式化、格式判定、播放模式推进、检索排序、洗牌、队列上下首、统计与模拟数据。
 * 这些都是 demo 中真正会产生 bug 的纯逻辑，界面层不重复测试。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('./core.js');

/* 用于精确断言的小样本，避免依赖模拟数据的细节 */
const sample = [
  { id: 'a', title: 'Blue Hour', artist: 'Aoi', album: 'Night', duration: 100 },
  { id: 'b', title: 'blue moon', artist: 'Kai', album: 'Dawn', duration: 200 },
  { id: 'c', title: '潮汐', artist: 'Aoi', album: 'Night', duration: 150 }
];

/* ==================== 时间格式化 ==================== */

test('formatTime 输出 m:ss 与 h:mm:ss', () => {
  assert.equal(core.formatTime(0), '0:00');
  assert.equal(core.formatTime(59), '0:59');
  assert.equal(core.formatTime(59.9), '0:59');
  assert.equal(core.formatTime(65), '1:05');
  assert.equal(core.formatTime(245), '4:05');
  assert.equal(core.formatTime(3600), '1:00:00');
  assert.equal(core.formatTime(3725), '1:02:05');
});

test('formatTime 对非法输入归零，不产生 NaN', () => {
  assert.equal(core.formatTime(-5), '0:00');
  assert.equal(core.formatTime(NaN), '0:00');
  assert.equal(core.formatTime(Infinity), '0:00');
  assert.equal(core.formatTime(undefined), '0:00');
  assert.equal(core.formatTime(null), '0:00');
  assert.equal(core.formatTime('abc'), '0:00');
});

test('formatDuration 用于曲库统计', () => {
  assert.equal(core.formatDuration(0), '0 分钟');
  assert.equal(core.formatDuration(2880), '48 分钟');
  assert.equal(core.formatDuration(11520), '3 小时 12 分');
});

test('formatDate 按本地时区输出日期', () => {
  const noon = new Date(2026, 0, 20, 12, 0, 0).getTime();
  assert.equal(core.formatDate(noon), '2026/01/20');
  assert.equal(core.formatDate('不是时间'), '—');
});

/* ==================== 格式与模式 ==================== */

test('isSupportedFormat 判定大小写不敏感', () => {
  ['mp3', 'flac', 'm4a', 'ogg', 'wav'].forEach((f) => {
    assert.equal(core.isSupportedFormat(f), true, f + ' 应受支持');
  });
  ['ape', 'APE', 'wv', 'dsf', ''].forEach((f) => {
    assert.equal(core.isSupportedFormat(f), false, f + ' 应不受支持');
  });
  assert.equal(core.isSupportedFormat(null), false);
  assert.equal(core.isSupportedFormat(undefined), false);
});

test('nextMode 在四种模式间循环', () => {
  assert.equal(core.nextMode('sequence'), 'repeat-all');
  assert.equal(core.nextMode('repeat-all'), 'repeat-one');
  assert.equal(core.nextMode('repeat-one'), 'shuffle');
  assert.equal(core.nextMode('shuffle'), 'sequence');
  // 未知模式回落到第一项，避免界面因脏数据卡死
  assert.equal(core.nextMode('nonsense'), 'sequence');
});

/* ==================== 检索与排序 ==================== */

test('filterTracks 搜索标题、艺术家、专辑，大小写不敏感', () => {
  assert.equal(core.filterTracks(sample, 'BLUE').length, 2);
  assert.equal(core.filterTracks(sample, 'aoi').length, 2);
  assert.equal(core.filterTracks(sample, 'night').length, 2);
  assert.equal(core.filterTracks(sample, '潮汐').length, 1);
  assert.equal(core.filterTracks(sample, '   ').length, 3, '空白查询应返回全部');
  assert.equal(core.filterTracks(sample, 'zzz').length, 0);
});

test('filterTracks 返回新数组，不改动入参', () => {
  const result = core.filterTracks(sample, '');
  assert.notEqual(result, sample);
  result.push({ id: 'x' });
  assert.equal(sample.length, 3);
});

test('sortTracks 按时长排序且支持降序', () => {
  const asc = core.sortTracks(sample, 'duration', 'asc').map((t) => t.duration);
  assert.deepEqual(asc, [100, 150, 200]);
  const desc = core.sortTracks(sample, 'duration', 'desc').map((t) => t.duration);
  assert.deepEqual(desc, [200, 150, 100]);
});

test('sortTracks 默认排序保持原有曲序', () => {
  const list = core.sortTracks(sample, 'default', 'asc');
  assert.deepEqual(list.map((t) => t.id), ['a', 'b', 'c']);
});

test('sortTracks 中文标题排序使用 zh 排序规则', () => {
  const tracks = core.createMockLibrary();
  const sorted = core.sortTracks(tracks, 'title', 'asc');
  assert.equal(sorted.length, tracks.length);
  for (let i = 1; i < sorted.length; i++) {
    const cmp = core.compareText(sorted[i - 1].title, sorted[i].title);
    assert.ok(cmp <= 0, '标题应非递减：' + sorted[i - 1].title + ' -> ' + sorted[i].title);
  }
});

test('groupBy 按字段分组并按分组名排序', () => {
  const groups = core.groupBy(sample, 'album');
  assert.deepEqual(groups.map((g) => g.key), ['Dawn', 'Night']);
  assert.equal(groups[0].tracks.length, 1);
  assert.equal(groups[1].tracks.length, 2);
  assert.equal(core.groupBy(sample, 'missing').length, 1, '缺失字段归入"未知"');
});

/* ==================== 洗牌 ==================== */

test('shuffleOrder 返回完整排列且不产生重复', () => {
  const order = core.shuffleOrder(24);
  assert.equal(order.length, 24);
  assert.deepEqual(order.slice().sort((a, b) => a - b), core.range(24));
  assert.equal(new Set(order).size, 24);
});

test('shuffleOrder 在固定随机源下结果确定', () => {
  const makeRng = () => {
    let seed = 42;
    return () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  };
  assert.deepEqual(core.shuffleOrder(10, makeRng()), core.shuffleOrder(10, makeRng()));
});

test('shuffleOrder 处理空与单元素队列', () => {
  assert.deepEqual(core.shuffleOrder(0), []);
  assert.deepEqual(core.shuffleOrder(1), [0]);
});

/* ==================== 下一首 / 上一首 ==================== */

test('resolveNextIndex 处理空队列与未开始状态', () => {
  assert.equal(core.resolveNextIndex({ mode: 'sequence', currentIndex: -1, queueLength: 0 }), -1);
  assert.equal(core.resolveNextIndex({ mode: 'sequence', currentIndex: -1, queueLength: 3 }), 0);
});

test('resolveNextIndex 顺序播放到末尾即结束', () => {
  assert.equal(core.resolveNextIndex({ mode: 'sequence', currentIndex: 0, queueLength: 3 }), 1);
  assert.equal(core.resolveNextIndex({ mode: 'sequence', currentIndex: 2, queueLength: 3 }), -1);
  assert.equal(core.resolveNextIndex({ mode: 'sequence', currentIndex: 2, queueLength: 3, auto: true }), -1);
});

test('resolveNextIndex 列表循环回到队首', () => {
  assert.equal(core.resolveNextIndex({ mode: 'repeat-all', currentIndex: 2, queueLength: 3 }), 0);
  assert.equal(core.resolveNextIndex({ mode: 'repeat-all', currentIndex: 2, queueLength: 3, auto: true }), 0);
});

test('resolveNextIndex 单曲循环区分自动与手动', () => {
  assert.equal(core.resolveNextIndex({ mode: 'repeat-one', currentIndex: 1, queueLength: 3, auto: true }), 1,
    '自然结束应重复本首');
  assert.equal(core.resolveNextIndex({ mode: 'repeat-one', currentIndex: 1, queueLength: 3 }), 2,
    '手动下一首应前进');
  assert.equal(core.resolveNextIndex({ mode: 'repeat-one', currentIndex: 2, queueLength: 3 }), 0);
});

test('resolveNextIndex 随机模式按洗牌序列推进并循环', () => {
  const order = [2, 0, 1];
  assert.equal(core.resolveNextIndex({ mode: 'shuffle', currentIndex: 2, queueLength: 3, order }), 0);
  assert.equal(core.resolveNextIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3, order }), 1);
  assert.equal(core.resolveNextIndex({ mode: 'shuffle', currentIndex: 1, queueLength: 3, order }), 2,
    '序列走完应回到序列开头');
});

test('resolveNextIndex 随机模式缺序列时退化为顺序推进', () => {
  assert.equal(core.resolveNextIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3 }), 1);
  assert.equal(core.resolveNextIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3, order: [9] }), 1);
});

test('resolvePrevIndex 顺序模式停在队首，其余模式回到队尾', () => {
  assert.equal(core.resolvePrevIndex({ mode: 'sequence', currentIndex: 0, queueLength: 3 }), 0);
  assert.equal(core.resolvePrevIndex({ mode: 'repeat-all', currentIndex: 0, queueLength: 3 }), 2);
  assert.equal(core.resolvePrevIndex({ mode: 'repeat-one', currentIndex: 0, queueLength: 3 }), 2);
  assert.equal(core.resolvePrevIndex({ mode: 'sequence', currentIndex: 2, queueLength: 3 }), 1);
  assert.equal(core.resolvePrevIndex({ mode: 'sequence', currentIndex: -1, queueLength: 3 }), 0);
});

test('resolvePrevIndex 随机模式沿洗牌序列回退', () => {
  const order = [2, 0, 1];
  assert.equal(core.resolvePrevIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3, order }), 2);
  assert.equal(core.resolvePrevIndex({ mode: 'shuffle', currentIndex: 1, queueLength: 3, order }), 0);
  assert.equal(core.resolvePrevIndex({ mode: 'shuffle', currentIndex: 2, queueLength: 3, order }), 1);
});

test('全程顺序播放不会重复或遗漏任何曲目', () => {
  const len = 6;
  const visited = [];
  let index = 0;
  for (let guard = 0; guard < 20; guard++) {
    visited.push(index);
    const next = core.resolveNextIndex({ mode: 'sequence', currentIndex: index, queueLength: len, auto: true });
    if (next === -1) break;
    index = next;
  }
  assert.deepEqual(visited, [0, 1, 2, 3, 4, 5]);
});

/* ==================== 模拟数据与统计 ==================== */

test('createMockLibrary 生成结构完整的曲目', () => {
  const tracks = core.createMockLibrary();
  assert.equal(tracks.length, 24);

  const ids = new Set();
  tracks.forEach((t) => {
    ids.add(t.id);
    assert.equal(typeof t.title, 'string');
    assert.ok(t.title.length > 0);
    assert.ok(t.artist && t.album);
    assert.ok(t.duration > 0, t.title + ' 时长应为正数');
    assert.equal(typeof t.supported, 'boolean');
    assert.ok(t.path.indexOf('.' + t.format) !== -1, '路径应包含扩展名');
    assert.equal(t.supported, core.isSupportedFormat(t.format));
  });
  assert.equal(ids.size, 24, 'id 应唯一');
});

test('createMockLibrary 包含不受支持的格式样本', () => {
  const tracks = core.createMockLibrary();
  const ape = tracks.filter((t) => t.format === 'ape');
  assert.equal(ape.length, 3);
  assert.ok(ape.every((t) => t.supported === false));
});

test('createMockLibrary 按专辑聚集且曲序号连续', () => {
  const tracks = core.createMockLibrary();
  for (let i = 1; i < tracks.length; i++) {
    assert.ok(tracks[i].albumIndex >= tracks[i - 1].albumIndex, '专辑应连续聚集');
  }
  const first = tracks.find((t) => t.album === '夏日回声');
  assert.equal(first.trackNo, 1);
});

test('buildQueue 只保留 id，视线图过滤影响', () => {
  const tracks = core.createMockLibrary();
  const queue = core.buildQueue(tracks);
  assert.equal(queue.length, 24);
  assert.equal(queue[0], 't01');
  assert.ok(queue.every((id) => typeof id === 'string'));
});

test('summarizeLibrary 统计曲库概况', () => {
  const tracks = core.createMockLibrary();
  const summary = core.summarizeLibrary(tracks);
  const expectedDuration = tracks.reduce((sum, t) => sum + t.duration, 0);

  assert.equal(summary.total, 24);
  assert.equal(summary.unsupported, 3);
  assert.equal(summary.artistCount, 4);
  assert.equal(summary.albumCount, 6);
  assert.equal(summary.duration, expectedDuration);
});

test('summarizeLibrary 处理空曲库', () => {
  const summary = core.summarizeLibrary([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.duration, 0);
  assert.equal(summary.unsupported, 0);
  assert.equal(summary.artistCount, 0);
});

test('summarizeLibrary 的时长可格式化为可读文本', () => {
  const tracks = core.createMockLibrary();
  const text = core.formatDuration(core.summarizeLibrary(tracks).duration);
  assert.match(text, /^(\d+ 小时 )?\d+ 分(钟)?$/);
});
