/**
 * store 的单测（jsdom）。
 *
 * `src/ui/store.ts` 是最大的编排文件，这里把能在 Node 里确定性验证的部分补上：
 * 视图/检索/排序的组合、分组摊平与收起、播放历史、问题文件诊断、队列增删与下标修正、
 * 音量与静音的联动、提示的进出，以及"IndexedDB 不可用时降级为内存存储"这条启动路径。
 *
 * 需要 jsdom 是因为 store 会写 `document.title`、挂 `visibilitychange` / `pagehide`；
 * jsdom 没有 IndexedDB，所以 `getServices()` 会走 `memoryStorage()` 降级——
 * 这本身就是产品在隐私模式下的真实行为，值得锁住。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListEntry } from '../core/sort.js';
import { buildSearchKey } from '../core/sort.js';
import type { Track } from '../core/track.js';
import { resetServices } from './services.js';
import {
  diagnoseTrack,
  entryTracks,
  getAudioElement,
  libraryStats,
  readLiveProgress,
  useAppStore,
  viewCounts,
  visibleEntries,
} from './store.js';
import type { LibraryView } from './store.js';

function track(path: string, overrides: Partial<Track> = {}): Track {
  const base: Track = {
    path,
    name: path.split('/').pop() ?? path,
    size: 1024,
    lastModified: 1,
    cacheKey: `${path}\u00001024\u00001`,
    title: path,
    titleFromFileName: false,
    durationSec: 200,
    extension: 'mp3',
    verdict: 'decodable',
    hasCover: false,
    addedAt: 1000,
    ...overrides,
  };
  return base;
}

const FILTERS = { query: '', sortKey: 'default' as const, sortDirection: 'asc' as const };

/** 把混合行压成好断言的形状：分组头记作 `[键]`，曲目记作 path。 */
function shapeOf(entries: Array<ListEntry<Track>>): string[] {
  return entries.map((entry) => (entry.kind === 'header' ? `[${entry.groupKey}]` : entry.track.path));
}

beforeEach(() => {
  resetServices();
  useAppStore.setState({
    ready: false,
    tracks: [],
    query: '',
    sortKey: 'default',
    sortDirection: 'asc',
    view: 'all',
    selectedPath: undefined,
    collapsedGroups: [],
    recentPaths: [],
    queue: [],
    currentIndex: -1,
    mode: 'sequence',
    playing: false,
    volume: 0.8,
    muted: false,
    drawer: 'none',
    lyricSearchTemplate: '',
    notices: [],
  });
});

describe('visibleEntries：视图 / 检索 / 排序', () => {
  const tracks = [
    track('a', { title: '青花瓷', artist: '周杰伦', album: '我很忙', durationSec: 200, addedAt: 300 }),
    track('b', { title: 'Duvet', artist: 'bôa', album: 'Twilight', durationSec: 203, addedAt: 100 }),
    track('c', { title: '第10首', artist: '周杰伦', album: '我很忙', durationSec: 100, addedAt: 200 }),
    track('d', { title: '水压', verdict: 'metadata-only', addedAt: 400 }),
  ];

  it('all 视图返回全部，且 sortKey=default 时保留原顺序', () => {
    expect(shapeOf(visibleEntries(tracks, { ...FILTERS, view: 'all' }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('recent 视图按入库时间倒序，且 sortKey=default 时不再被标题重排', () => {
    expect(shapeOf(visibleEntries(tracks, { ...FILTERS, view: 'recent' }))).toEqual([
      'd',
      'a',
      'c',
      'b',
    ]);
  });

  it('played 视图按播放历史倒序，且只保留在库的曲目', () => {
    const entries = visibleEntries(tracks, {
      ...FILTERS,
      view: 'played',
      recentPaths: ['c', '已删除的', 'a'],
    });
    expect(shapeOf(entries)).toEqual(['c', 'a']);
  });

  it('diagnostics 视图只留需要留意的文件', () => {
    const withError = [...tracks, track('e', { parseError: 'Failed to determine' })];
    expect(shapeOf(visibleEntries(withError, { ...FILTERS, view: 'diagnostics' }))).toEqual([
      'd',
      'e',
    ]);
  });

  it('artist / album 视图摊平成混合行，分组头在曲目之前', () => {
    const entries = visibleEntries(tracks, { ...FILTERS, view: 'artist' });
    // 分组顺序由中文 collator 决定：汉字按拼音在前（未 w < 周 z），拉丁字母在后
    expect(shapeOf(entries)).toEqual([
      '[未知]',
      'd',
      '[周杰伦]',
      'a',
      'c',
      '[bôa]',
      'b',
    ]);
  });

  it('收起的艺术家的曲目不再出现，但分组头保留', () => {
    const entries = visibleEntries(tracks, {
      ...FILTERS,
      view: 'artist',
      collapsedGroups: ['周杰伦'],
    });
    expect(shapeOf(entries)).toEqual(['[未知]', 'd', '[周杰伦]', '[bôa]', 'b']);
  });

  it('分组视图里也能检索', () => {
    const entries = visibleEntries(tracks, { ...FILTERS, view: 'album', query: '周杰伦' });
    expect(shapeOf(entries)).toEqual(['[我很忙]', 'a', 'c']);
  });

  it('entryTracks 给出队列顺序（跳过分组头）', () => {
    const entries = visibleEntries(tracks, { ...FILTERS, view: 'artist' });
    expect(entryTracks(entries).map((item) => item.path)).toEqual(['d', 'a', 'c', 'b']);
  });

  it('检索命中标题 / 艺术家 / 专辑，且忽略大小写与拉丁变音符号', () => {
    const byTitle = visibleEntries(tracks, { ...FILTERS, view: 'all', query: '青花' });
    expect(shapeOf(byTitle)).toEqual(['a']);

    // 'bôa' 用普通字母 boa 也要搜得到（工作区里就有 bôa - Duvet.flac）
    const byArtist = visibleEntries(tracks, { ...FILTERS, view: 'all', query: 'BOA' });
    expect(shapeOf(byArtist)).toEqual(['b']);

    const byAlbum = visibleEntries(tracks, { ...FILTERS, view: 'all', query: '我很忙' });
    expect(shapeOf(byAlbum)).toEqual(['a', 'c']);
  });

  it('拼音首字母也能检索（zjl / qhc）', () => {
    expect(shapeOf(visibleEntries(tracks, { ...FILTERS, view: 'all', query: 'zjl' }))).toEqual([
      'a',
      'c',
    ]);
    expect(shapeOf(visibleEntries(tracks, { ...FILTERS, view: 'all', query: 'qhc' }))).toEqual(['a']);
  });

  it('检索与视图叠加生效', () => {
    expect(visibleEntries(tracks, { ...FILTERS, view: 'diagnostics', query: '周杰伦' })).toEqual([]);
  });

  it('按标题升序用中文 collator（第10首 排在 第2首 之后）', () => {
    const list = [track('x', { title: '第10首' }), track('y', { title: '第2首' }), track('z', { title: '第1首' })];
    const asc = visibleEntries(list, { ...FILTERS, view: 'all', sortKey: 'title' });
    expect(entryTracks(asc).map((item) => item.title)).toEqual(['第1首', '第2首', '第10首']);

    const desc = visibleEntries(list, {
      ...FILTERS,
      view: 'all',
      sortKey: 'title',
      sortDirection: 'desc',
    });
    expect(entryTracks(desc).map((item) => item.title)).toEqual(['第10首', '第2首', '第1首']);
  });

  it('按时长排序走数值比较', () => {
    const result = visibleEntries(tracks, { ...FILTERS, view: 'all', sortKey: 'duration' });
    // d 没有覆盖 durationSec，用的是工厂默认值 200
    expect(entryTracks(result).map((item) => item.durationSec)).toEqual([100, 200, 200, 203]);
  });
});

describe('diagnoseTrack', () => {
  it('正常曲目没有诊断结果', () => {
    expect(diagnoseTrack(track('a'))).toBeUndefined();
  });

  it('格式放不出声 → unsupported，并带上说明', () => {
    const diagnosis = diagnoseTrack(track('a.ape', { verdict: 'metadata-only', verdictNote: '浏览器无法解码该格式' }));
    expect(diagnosis).toEqual({ code: 'unsupported', reason: '浏览器无法解码该格式' });
  });

  it('解析失败优先于格式判定', () => {
    const diagnosis = diagnoseTrack(
      track('a.ape', { verdict: 'metadata-only', parseError: 'EndOfStreamError' }),
    );
    expect(diagnosis?.code).toBe('parse-error');
    expect(diagnosis?.reason).toContain('EndOfStreamError');
  });
});

describe('viewCounts', () => {
  it('艺术家/专辑给的是分组数，播放历史只算在库的', () => {
    const tracks = [
      track('a', { artist: '周杰伦', album: '我很忙' }),
      track('b', { artist: '周杰伦', album: '我很忙' }),
      track('c', { artist: 'bôa', album: 'Twilight' }),
      track('d', { verdict: 'metadata-only', artist: undefined, album: undefined }),
    ];

    expect(viewCounts(tracks, ['a', 'b', '已删除'])).toEqual({
      all: 4,
      artist: 3, // 周杰伦 / bôa / 未知
      album: 3,
      recent: 4,
      played: 2,
      diagnostics: 1,
    });
  });

  it('空曲库全为 0', () => {
    expect(viewCounts([], [])).toEqual({
      all: 0,
      artist: 0,
      album: 0,
      recent: 0,
      played: 0,
      diagnostics: 0,
    });
  });
});

describe('libraryStats', () => {
  it('统计总数、总时长、艺术家与专辑数、不支持数', () => {
    const stats = libraryStats([
      track('a', { artist: '周杰伦', album: '我很忙', durationSec: 200 }),
      track('b', { artist: '周杰伦', album: '我很忙', durationSec: 100 }),
      track('c', { artist: 'bôa', album: 'Twilight', durationSec: 50 }),
      // 缺时长、缺艺术家与专辑：不计入艺术家/专辑数，时长按 0 计
      track('d', { verdict: 'metadata-only', durationSec: undefined }),
    ]);

    expect(stats).toEqual({ total: 4, durationSec: 350, artists: 2, albums: 2, unsupported: 1 });
  });

  it('空曲库与缺字段都不炸', () => {
    expect(libraryStats([])).toEqual({ total: 0, durationSec: 0, artists: 0, albums: 0, unsupported: 0 });

    const stats = libraryStats([track('a', { artist: undefined, album: undefined, durationSec: undefined })]);
    expect(stats).toMatchObject({ total: 1, durationSec: 0, artists: 0, albums: 0 });
  });
});

describe('store：视图与检索动作', () => {
  it('setSort 同键再次点击切换升降序，换键时重置为升序', () => {
    const { setSort } = useAppStore.getState();

    setSort('title');
    expect(useAppStore.getState()).toMatchObject({ sortKey: 'title', sortDirection: 'asc' });

    setSort('title');
    expect(useAppStore.getState().sortDirection).toBe('desc');

    setSort('artist');
    expect(useAppStore.getState()).toMatchObject({ sortKey: 'artist', sortDirection: 'asc' });
  });

  it('setSort("default") 不会把方向翻转成 desc', () => {
    useAppStore.getState().setSort('title');
    useAppStore.getState().setSort('title');
    useAppStore.getState().setSort('default');
    expect(useAppStore.getState()).toMatchObject({ sortKey: 'default', sortDirection: 'asc' });
  });

  it('setQuery / setView / select 直接落到状态上', () => {
    const store = useAppStore.getState();
    store.setQuery('青花');
    store.setView('diagnostics' as LibraryView);
    store.select('专辑/a.flac');

    expect(useAppStore.getState()).toMatchObject({
      query: '青花',
      view: 'diagnostics',
      selectedPath: '专辑/a.flac',
    });
  });

  it('toggleGroup 收起再展开', () => {
    useAppStore.getState().toggleGroup('周杰伦');
    expect(useAppStore.getState().collapsedGroups).toEqual(['周杰伦']);

    useAppStore.getState().toggleGroup('bôa');
    expect(useAppStore.getState().collapsedGroups).toEqual(['周杰伦', 'bôa']);

    useAppStore.getState().toggleGroup('周杰伦');
    expect(useAppStore.getState().collapsedGroups).toEqual(['bôa']);
  });
});

describe('store：音量与静音', () => {
  it('音量被夹在 0..1，拖到 0 会自动静音', () => {
    const { setVolume } = useAppStore.getState();

    setVolume(2);
    expect(useAppStore.getState().volume).toBe(1);
    expect(useAppStore.getState().muted).toBe(false);

    setVolume(0);
    expect(useAppStore.getState().volume).toBe(0);
    expect(useAppStore.getState().muted).toBe(true);

    setVolume(0.4);
    expect(useAppStore.getState()).toMatchObject({ volume: 0.4, muted: false });
  });

  it('toggleMute 只翻转静音，不动音量', () => {
    useAppStore.getState().setVolume(0.6);
    useAppStore.getState().toggleMute();
    expect(useAppStore.getState()).toMatchObject({ muted: true, volume: 0.6 });

    useAppStore.getState().toggleMute();
    expect(useAppStore.getState().muted).toBe(false);
  });
});

describe('store：播放模式与队列抽屉', () => {
  it('cycleMode 依次循环四种模式并回到起点', () => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      useAppStore.getState().cycleMode();
      seen.push(useAppStore.getState().mode);
    }
    expect(seen).toEqual(['repeat-all', 'repeat-one', 'shuffle', 'sequence']);
  });

  it('toggleQueue / toggleLyrics 共用右抽屉，各自能开关', () => {
    useAppStore.getState().toggleQueue();
    expect(useAppStore.getState().drawer).toBe('queue');

    // 打开歌词会切成歌词标签页，而不是同时开两个
    useAppStore.getState().toggleLyrics();
    expect(useAppStore.getState().drawer).toBe('lyrics');

    useAppStore.getState().toggleLyrics();
    expect(useAppStore.getState().drawer).toBe('none');

    useAppStore.getState().toggleQueue();
    useAppStore.getState().toggleQueue();
    expect(useAppStore.getState().drawer).toBe('none');
  });
});

describe('store：歌词动作', () => {
  it('保存歌词后能从存储读出来，并带上来源', async () => {
    await useAppStore.getState().boot();
    const services = await import('./services.js').then((module) => module.getServices());

    await useAppStore.getState().saveLyrics('a.flac', '[00:01.00]词', 'paste');

    const record = await services.storage.getLyrics('a.flac');
    expect(record).toMatchObject({ text: '[00:01.00]词', source: 'paste', userOffsetSec: 0 });
  });

  it('再次保存会覆盖，但保留用户已调好的偏移', async () => {
    await useAppStore.getState().boot();
    const services = await import('./services.js').then((module) => module.getServices());

    await useAppStore.getState().saveLyrics('a.flac', '第一版', 'import');
    await useAppStore.getState().nudgeLyricOffset('a.flac', 0.5);
    await useAppStore.getState().saveLyrics('a.flac', '第二版', 'paste');

    const record = await services.storage.getLyrics('a.flac');
    expect(record?.text).toBe('第二版');
    expect(record?.userOffsetSec).toBe(0.5);
    // 换成用户来源之后不该再留着 sidecar 关联
    expect(record?.lyricPath).toBeUndefined();
  });

  it('偏移微调累加并四舍五入到两位小数', async () => {
    await useAppStore.getState().boot();
    const services = await import('./services.js').then((module) => module.getServices());

    await useAppStore.getState().saveLyrics('a.flac', '词', 'paste');
    await useAppStore.getState().nudgeLyricOffset('a.flac', 0.5);
    await useAppStore.getState().nudgeLyricOffset('a.flac', 0.5);
    await useAppStore.getState().nudgeLyricOffset('a.flac', -0.25);

    expect((await services.storage.getLyrics('a.flac'))?.userOffsetSec).toBe(0.75);
  });

  it('移除歌词后就查不到了', async () => {
    await useAppStore.getState().boot();
    const services = await import('./services.js').then((module) => module.getServices());

    await useAppStore.getState().saveLyrics('a.flac', '词', 'paste');
    await useAppStore.getState().removeLyrics('a.flac');

    expect(await services.storage.getLyrics('a.flac')).toBeUndefined();
  });

  it('保存搜索地址模板会持久化（默认是空的，不内置任何站点）', async () => {
    await useAppStore.getState().boot();
    const services = await import('./services.js').then((module) => module.getServices());
    expect(useAppStore.getState().lyricSearchTemplate).toBe('');

    await useAppStore.getState().setLyricSearchTemplate('  https://example.com/?q={keyword}  ');

    expect(useAppStore.getState().lyricSearchTemplate).toBe('https://example.com/?q={keyword}');
    expect((await services.storage.readSettings())?.lyricSearchTemplate).toBe(
      'https://example.com/?q={keyword}',
    );
  });

  it('没有曲库来源时重新扫描歌词只给提示，不抛异常', async () => {
    await useAppStore.getState().boot();
    await useAppStore.getState().rescanLyrics();

    expect(useAppStore.getState().notices.at(-1)?.message).toContain('还没有曲库来源');
  });
});

describe('store：队列增删与下一首播放', () => {
  const QUEUE = ['a', 'b', 'c'];

  it('移除当前曲目 → 下标置 -1 并停止播放', () => {
    useAppStore.setState({ queue: QUEUE, currentIndex: 1 });
    useAppStore.getState().removeFromQueue(1);

    expect(useAppStore.getState()).toMatchObject({ queue: ['a', 'c'], currentIndex: -1 });
  });

  it('移除当前曲目之前的项 → 下标减 1，仍然指向同一首歌', () => {
    useAppStore.setState({ queue: QUEUE, currentIndex: 2 });
    useAppStore.getState().removeFromQueue(0);

    const state = useAppStore.getState();
    expect(state.queue).toEqual(['b', 'c']);
    expect(state.queue[state.currentIndex]).toBe('c');
  });

  it('移除当前曲目之后的项 → 下标不变', () => {
    useAppStore.setState({ queue: QUEUE, currentIndex: 0 });
    useAppStore.getState().removeFromQueue(2);

    expect(useAppStore.getState()).toMatchObject({ queue: ['a', 'b'], currentIndex: 0 });
  });

  it('越界下标不做任何改动', () => {
    useAppStore.setState({ queue: QUEUE, currentIndex: 1 });
    useAppStore.getState().removeFromQueue(9);
    useAppStore.getState().removeFromQueue(-1);

    expect(useAppStore.getState()).toMatchObject({ queue: QUEUE, currentIndex: 1 });
  });

  it('playNext 把曲目插到当前之后，并保持当前曲目不变', () => {
    useAppStore.setState({
      queue: QUEUE,
      currentIndex: 1,
      tracks: [track('a'), track('b'), track('c'), track('x', { title: '插队曲' })],
    });
    useAppStore.getState().playNext('x');

    const state = useAppStore.getState();
    expect(state.queue).toEqual(['a', 'b', 'x', 'c']);
    expect(state.queue[state.currentIndex]).toBe('b');
    expect(state.notices.at(-1)?.message).toContain('插队曲');
  });

  it('playNext 对已在队列里的曲目先摘掉再插，下标仍然指向原曲目', () => {
    useAppStore.setState({ queue: QUEUE, currentIndex: 1, tracks: [track('a'), track('b'), track('c')] });
    useAppStore.getState().playNext('a');

    const state = useAppStore.getState();
    expect(state.queue).toEqual(['b', 'a', 'c']);
    expect(state.queue[state.currentIndex]).toBe('b');
  });

  it('队列为空时 playNext 直接开始播放这一首', async () => {
    // 先 boot：boot 会用存储里的曲库覆盖内存列表，顺序反了的话曲目会被清空
    await useAppStore.getState().boot();
    useAppStore.setState({ queue: [], currentIndex: -1, tracks: [track('x')] });

    useAppStore.getState().playNext('x');

    // playAt 是异步的：先建队列，再去打来源。等"打不开来源"的提示出现，
    // 说明整条链路已经走到尽头（测试环境里没有真实文件来源）
    await vi.waitFor(() =>
      expect(
        useAppStore.getState().notices.some((notice) => notice.message.includes('打开失败')),
      ).toBe(true),
    );
    expect(useAppStore.getState().queue).toEqual(['x']);
    // 打不开来源时不会把下标设成一个放不出来的曲目
    expect(useAppStore.getState().currentIndex).toBe(-1);
  });

  it('clearQueue 清空队列、复位下标并更新窗口标题', () => {
    useAppStore.setState({ queue: QUEUE, currentIndex: 1, resumePath: 'b' });
    document.title = '某首歌 - 轻音播放';

    useAppStore.getState().clearQueue();

    expect(useAppStore.getState()).toMatchObject({ queue: [], currentIndex: -1, shuffleOrder: [] });
    expect(useAppStore.getState().resumePath).toBeUndefined();
    expect(document.title).toBe('轻音播放');
  });
});

describe('store：提示', () => {
  it('pushNotice 追加并用自增 id 区分，dismissNotice 能移除', () => {
    const { pushNotice } = useAppStore.getState();
    pushNotice('第一条');
    pushNotice('第二条', 'warn');

    const notices = useAppStore.getState().notices;
    expect(notices.map((notice) => notice.message)).toEqual(['第一条', '第二条']);
    expect(notices[1]?.kind).toBe('warn');
    expect(notices[0]?.id).not.toBe(notices[1]?.id);

    useAppStore.getState().dismissNotice(notices[0]!.id);
    expect(useAppStore.getState().notices.map((notice) => notice.message)).toEqual(['第二条']);
  });

  it('提示会自己过期消失', () => {
    vi.useFakeTimers();
    try {
      useAppStore.getState().pushNotice('很快就走');
      expect(useAppStore.getState().notices).toHaveLength(1);

      vi.advanceTimersByTime(4000);
      expect(useAppStore.getState().notices).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('store：启动（IndexedDB 不可用时降级）', () => {
  it('boot 后进入就绪态；jsdom 没有 IndexedDB，于是降级为内存存储', async () => {
    await useAppStore.getState().boot();

    const state = useAppStore.getState();
    expect(state.ready).toBe(true);
    expect(state.persistent).toBe(false);
    expect(state).toMatchObject({
      tracks: [],
      volume: 0.8,
      muted: false,
      mode: 'sequence',
      recentPaths: [],
    });
    expect(state.canRestore).toBe(false);
  });

  it('boot 之后播放引擎可用，进度读取有确定结果', async () => {
    await useAppStore.getState().boot();

    expect(getAudioElement()).toBeDefined();
    expect(readLiveProgress()).toEqual({ positionSec: 0, durationSec: 0 });
  });

  it('重复调用 boot 不会重复初始化', async () => {
    const first = useAppStore.getState().boot();
    const second = useAppStore.getState().boot();
    await Promise.all([first, second]);

    const element = getAudioElement();
    await useAppStore.getState().boot();
    expect(getAudioElement()).toBe(element);
  });

  it('为旧缓存补算检索键（老记录没有 searchKey 时也能用拼音搜到）', async () => {
    // 造一条"旧版本写进去的"记录：没有 searchKey
    const legacy = track('旧/青花瓷.flac', { title: '青花瓷', artist: '周杰伦' });
    delete (legacy as { searchKey?: string }).searchKey;

    const services = await import('./services.js').then((module) => module.getServices());
    await services.storage.putTracks([legacy]);

    await useAppStore.getState().boot();

    const loaded = useAppStore.getState().tracks[0];
    expect(loaded?.searchKey).toBe(buildSearchKey({ title: '青花瓷', artist: '周杰伦' }));

    // 补算之后拼音检索立刻可用
    const entries = visibleEntries(useAppStore.getState().tracks, {
      ...FILTERS,
      view: 'all',
      query: 'qhc',
    });
    expect(entryTracks(entries)).toHaveLength(1);
  });
});
