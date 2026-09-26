import { describe, expect, it } from 'vitest';
import { compareText, filterTracks, groupBy, sortTracks } from './sort.js';
import type { SortableTrack } from './sort.js';

/** 与 Demo 用例同形的小样本，便于逐条对照断言。 */
const sample: SortableTrack[] = [
  { title: 'Blue Hour', artist: 'Aoi', album: 'Night', durationSec: 100 },
  { title: 'blue moon', artist: 'Kai', album: 'Dawn', durationSec: 200 },
  { title: '潮汐', artist: 'Aoi', album: 'Night', durationSec: 150 },
];

describe('compareText', () => {
  it('空值当空串处理，不产出 NaN', () => {
    expect(compareText(undefined, undefined)).toBe(0);
    expect(compareText(null, '')).toBe(0);
    expect(compareText('', undefined)).toBe(0);
    expect(Number.isNaN(compareText(undefined, 'a'))).toBe(false);
  });

  it('大小写与变音符号不敏感（sensitivity: base）', () => {
    expect(compareText('blue', 'BLUE')).toBe(0);
    expect(compareText('Blue Hour', 'blue hour')).toBe(0);
  });

  it('numeric 生效：第2首 排在 第10首 前面', () => {
    expect(compareText('第2首', '第10首')).toBeLessThan(0);
    expect(compareText('2', '10')).toBeLessThan(0);
  });

  it('中文按拼音排序，且相对顺序稳定', () => {
    // 「北京」拼音 bei < 「青花瓷」qing
    expect(compareText('北京', '青花瓷')).toBeLessThan(0);
    expect(compareText('青花瓷', '北京')).toBeGreaterThan(0);
    expect(compareText('北京', '青花瓷')).toBe(compareText('北京', '青花瓷'));
  });

  it('数字等非字符串入参先转成文本', () => {
    expect(compareText(1, 1)).toBe(0);
    expect(compareText(2, 10)).toBeLessThan(0);
  });
});

describe('filterTracks', () => {
  it('搜索标题、艺术家、专辑，大小写不敏感', () => {
    expect(filterTracks(sample, 'BLUE')).toHaveLength(2);
    expect(filterTracks(sample, 'aoi')).toHaveLength(2);
    expect(filterTracks(sample, 'night')).toHaveLength(2);
    expect(filterTracks(sample, '潮汐')).toHaveLength(1);
    expect(filterTracks(sample, 'zzz')).toHaveLength(0);
  });

  it('空白查询返回全部', () => {
    expect(filterTracks(sample, '   ')).toHaveLength(3);
    expect(filterTracks(sample, '')).toHaveLength(3);
  });

  it('查询串两端空白被忽略', () => {
    expect(filterTracks(sample, '  aoi  ')).toHaveLength(2);
  });

  it('缺失字段不会抛错，也不会被误命中', () => {
    const bare: SortableTrack[] = [{}, { title: '有标题' }];
    expect(filterTracks(bare, '有')).toHaveLength(1);
    expect(filterTracks(bare, 'undefined')).toHaveLength(0);
    expect(filterTracks(bare, 'a')).toHaveLength(0);
  });

  it('返回新数组，不改动入参', () => {
    const result = filterTracks(sample, '');
    expect(result).not.toBe(sample);
    result.push({ title: 'x' });
    expect(sample).toHaveLength(3);
    // 命中的分支同样不是原数组
    expect(filterTracks(sample, 'aoi')).not.toBe(sample);
  });
});

describe('sortTracks', () => {
  it('按时长排序且支持降序', () => {
    expect(sortTracks(sample, 'duration', 'asc').map((t) => t.durationSec)).toEqual([100, 150, 200]);
    expect(sortTracks(sample, 'duration', 'desc').map((t) => t.durationSec)).toEqual([200, 150, 100]);
  });

  it('默认方向为升序', () => {
    expect(sortTracks(sample, 'duration').map((t) => t.durationSec)).toEqual([100, 150, 200]);
  });

  it('default 键原样返回副本', () => {
    const list = sortTracks(sample, 'default', 'asc');
    expect(list.map((t) => t.title)).toEqual(['Blue Hour', 'blue moon', '潮汐']);
    expect(list).not.toBe(sample);
    expect(list).toEqual(sample);
  });

  it('按标题排序使用 zh 规则，结果非递减', () => {
    const tracks: SortableTrack[] = [
      { title: '青花瓷' },
      { title: '北京' },
      { title: '第10首' },
      { title: '第2首' },
      { title: 'Blue Hour' },
    ];
    const sorted = sortTracks(tracks, 'title', 'asc');
    for (let i = 1; i < sorted.length; i += 1) {
      const cmp = compareText(sorted[i - 1]!.title, sorted[i]!.title);
      expect(cmp, `${sorted[i - 1]!.title} -> ${sorted[i]!.title}`).toBeLessThanOrEqual(0);
    }
    expect(sorted.findIndex((t) => t.title === '第2首')).toBeLessThan(
      sorted.findIndex((t) => t.title === '第10首'),
    );
    expect(sorted.map((t) => t.title)).toContain('青花瓷');
  });

  it('主键相等时用标题兜底', () => {
    const tracks: SortableTrack[] = [
      { title: 'B', artist: '同一人' },
      { title: 'A', artist: '同一人' },
    ];
    expect(sortTracks(tracks, 'artist', 'asc').map((t) => t.title)).toEqual(['A', 'B']);
    // 降序时兜底键一并反向，结果才是完全倒过来
    expect(sortTracks(tracks, 'artist', 'desc').map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('空值与缺失时长按 0 处理', () => {
    const tracks: SortableTrack[] = [
      { title: '有时长', durationSec: 100 },
      { title: '缺失' },
      { title: '负时长', durationSec: -5 },
    ];
    const sorted = sortTracks(tracks, 'duration', 'asc');
    expect(sorted.map((t) => t.title)).toEqual(['负时长', '缺失', '有时长']);
    expect(sorted[0]!.durationSec).toBe(-5);
    expect(sorted.at(-1)!.durationSec).toBe(100);
    expect(sortTracks(tracks, 'duration', 'desc').map((t) => t.title)).toEqual(['有时长', '缺失', '负时长']);
    // 空艺术家当空串，排在有值的前面
    expect(sortTracks(tracks, 'artist', 'asc')[0]!.artist).toBeUndefined();
    expect(sortTracks(tracks, 'artist', 'desc').at(-1)!.artist).toBeUndefined();
  });

  it('NaN 时长不破坏比较契约（不抛错、不丢失）', () => {
    const tracks: SortableTrack[] = [
      { title: '正常', durationSec: 100 },
      { title: 'NaN 时长', durationSec: NaN },
      { title: '零时长', durationSec: 0 },
    ];
    const sorted = sortTracks(tracks, 'duration', 'asc');
    expect(sorted).toHaveLength(3);
    // NaN 参与减法会得到 NaN，V8 对 NaN 比较的实现细节不保证，所以只断言：
    // 不抛错、不丢曲目、正常值之间的相对次序仍然正确
    const finite = sorted.filter((t) => !Number.isNaN(t.durationSec)).map((t) => t.durationSec);
    expect(finite).toEqual([0, 100]);
  });

  it('返回新数组，不改动入参', () => {
    const before = sample.map((t) => t.title);
    const sorted = sortTracks(sample, 'title', 'desc');
    expect(sorted).not.toBe(sample);
    expect(sample.map((t) => t.title)).toEqual(before);
  });

  it('中文与英文混排不抛错且长度不变', () => {
    const tracks: SortableTrack[] = [{ title: '北京' }, { title: '青花瓷' }, { title: 'Aurora' }];
    const sorted = sortTracks(tracks, 'title', 'asc');
    expect(sorted).toHaveLength(3);
    expect(new Set(sorted.map((t) => t.title)).size).toBe(3);
  });
});

describe('groupBy', () => {
  it('按字段分组并按分组名排序', () => {
    const groups = groupBy(sample, 'album');
    expect(groups.map((g) => g.key)).toEqual(['Dawn', 'Night']);
    expect(groups[0]!.tracks).toHaveLength(1);
    expect(groups[1]!.tracks).toHaveLength(2);
  });

  it('空的分组键归入「未知」', () => {
    const tracks: SortableTrack[] = [
      { title: 'a', artist: 'Aoi' },
      { title: 'b' },
      { title: 'c', artist: '' },
      { title: 'd', artist: '   ' },
    ];
    const groups = groupBy(tracks, 'artist');
    // zh-Hans-CN 排序把汉字排在拉丁字母前，所以「未知」在前
    expect(groups.map((g) => g.key)).toEqual(['未知', 'Aoi']);
    const unknown = groups.find((g) => g.key === '未知')!;
    expect(unknown.tracks.map((t) => t.title)).toEqual(['b', 'c', 'd']);
  });

  it('分组名排序与 compareText 一致', () => {
    const tracks: SortableTrack[] = [
      { title: '1', artist: '青花' },
      { title: '2', artist: '北京' },
      { title: '3', artist: 'Alice' },
    ];
    const keys = groupBy(tracks, 'artist').map((g) => g.key);
    expect(keys).toEqual([...keys].sort(compareText));
    // 汉字之间按拼音：「北京」在「青花」前面
    expect(keys.indexOf('北京')).toBeLessThan(keys.indexOf('青花'));
  });

  it('空输入返回空数组，不产生空分组', () => {
    expect(groupBy([], 'album')).toEqual([]);
    const groups = groupBy([{ title: 'x', album: 'Dawn' }], 'album');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('Dawn');
  });

  it('不改动入参、不丢曲目', () => {
    const tracks: SortableTrack[] = [
      { title: 'a', album: 'X' },
      { title: 'b', album: 'X' },
      { title: 'c', album: 'Y' },
    ];
    const groups = groupBy(tracks, 'album');
    expect(groups.flatMap((g) => g.tracks)).toHaveLength(3);
    expect(tracks).toHaveLength(3);
  });
});
