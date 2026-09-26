/**
 * 检索、排序与分组的纯逻辑。不引用任何平台 API。
 *
 * 中文排序必须走 `Intl.Collator`：默认的 `String.prototype.localeCompare` 在部分运行时
 * 会把「青花瓷」排到「北京」前面（按 UTF-16 码元比较），而且不会把「第2首」排在「第10首」
 * 前面。Collator 的构造开销明显（要建排序表），列表每次比较都新建一个会让排序慢一个数量级，
 * 所以模块级只构造一次并全程复用；极端环境下构造失败就退回 `localeCompare`。
 *
 * 所有函数都返回新数组，不改动入参——排序结果会直接喂给 React 渲染，就地改动会让
 * state 的引用不变，界面反而看不到更新。
 */
import type { SortDirection, TrackSortKey } from './track.js';
import { pinyinInitialsVariants } from './pinyin.js';

/** 参与排序/检索的最小字段集合，Track 天然满足它。 */
export interface SortableTrack {
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  /**
   * 预计算的检索键（见 `buildSearchKey`）。
   *
   * 之所以要预计算：拼音首字母要逐字查表，3000 首 × 每首几十个字，
   * 每次敲键都现算会明显卡手。它由 `buildTrack` 在入库时写好；
   * 老版本缓存里的记录没有这个字段，`filterTracks` 会现场兜底（正确性优先）。
   */
  searchKey?: string;
}

/** 复用的中文 collator；构造失败时为 null，走 localeCompare 兜底。 */
const collator: Intl.Collator | null = createCollator();

function createCollator(): Intl.Collator | null {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch {
    return null;
  }
}

/** 排序/分组时给空值用的展示占位。 */
const UNKNOWN = '未知';

/** 空值一律当空串，避免 `undefined` 混进比较函数产出 NaN。 */
function toText(value: unknown): string {
  return value == null ? '' : String(value);
}

/** 比较两段文本；空值当空串处理。 */
export function compareText(a: unknown, b: unknown): number {
  const x = toText(a);
  const y = toText(b);
  if (collator) return collator.compare(x, y);
  return x.localeCompare(y);
}

/** 曲目时长：缺失或非法当 0 秒。 */
function durationOf(track: SortableTrack): number {
  const value = track.durationSec;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 用于排序的字段文本；`duration` 之外的键都按文本比较。 */
function fieldOf(track: SortableTrack, key: Exclude<TrackSortKey, 'default' | 'duration'>): string {
  return toText(track[key]);
}

/**
 * 检索用的规范化：去掉变音符号 + 转小写。
 *
 * 曲库里 `bôa - Duvet`、`Café` 这类带变音符号的标签很常见，而用户敲的是普通字母，
 * 只做 `toLowerCase()` + 子串匹配会让「搜 boa 找不到 bôa」（这是实测踩到的：
 * 工作区里就有一首 `bôa - Duvet.flac`）。做法是 NFD 分解后去掉组合记号，
 * 比引入拼音库便宜得多，且不依赖任何平台 API。
 *
 * 注意这只解决拉丁字母的变音符号；中文的拼音/首字母检索是另一件事。
 */
export function normalizeForSearch(value: unknown): string {
  return toText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * 检索键的分隔符：用不可能出现在标签里的控制字符，避免"拼音首字母段"和"字段段"黏在一起
 * 产生跨段的假命中。
 */
const SEARCH_KEY_SEPARATOR = '\u0000';

/**
 * 为一个曲目预计算检索键：`规范化后的标题/艺术家/专辑` + 分隔符 + `各字段的拼音首字母变体`。
 *
 * 检索时只要在这一个字符串上做子串匹配，就能同时命中三种输入：
 *  - 汉字子串（「青花」）
 *  - 拉丁字母（「duvet」、忽略变音符号的「boa」）
 *  - 拼音首字母（「qhc」、「zjl」）
 */
export function buildSearchKey(track: SortableTrack): string {
  const fields = [track.title, track.artist, track.album];
  const parts = fields.map((field) => normalizeForSearch(field)).filter(Boolean);

  const initials = new Set<string>();
  for (const field of fields) {
    for (const variant of pinyinInitialsVariants(toText(field))) initials.add(variant);
  }

  return parts.join(' ') + SEARCH_KEY_SEPARATOR + [...initials].join(' ');
}

/**
 * 子串匹配标题 / 艺术家 / 专辑，忽略大小写与拉丁变音符号，查询串两端空白忽略。
 * 空查询返回全部（依然是新数组）。
 *
 * 匹配对象是预计算的检索键（含拼音首字母）；老缓存里没有检索键的记录会现场兜底。
 */
export function filterTracks<T extends SortableTrack>(tracks: readonly T[], query: string): T[] {
  const needle = normalizeForSearch(query).trim();
  if (!needle) return tracks.slice();
  return tracks.filter((track) => {
    const key = track.searchKey ?? buildSearchKey(track);
    return key.includes(needle);
  });
}

/**
 * 排序（返回新数组，不改动入参）。
 *
 * - `duration` 用数值比较，其它键用 `compareText`
 * - 主键相等时用 `title` 兜底，保证同专辑曲目的顺序稳定可预期
 * - `desc` 整体取反（而不是只反主键），兜底键也随之反向，结果才是"完全倒过来"
 */
export function sortTracks<T extends SortableTrack>(
  tracks: readonly T[],
  key: TrackSortKey,
  direction: SortDirection = 'asc',
): T[] {
  const list = tracks.slice();
  if (key === 'default') return list;

  const sign = direction === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    const primary =
      key === 'duration' ? durationOf(a) - durationOf(b) : compareText(fieldOf(a, key), fieldOf(b, key));
    const result = primary === 0 ? compareText(a.title, b.title) : primary;
    return result * sign;
  });
  return list;
}

/**
 * 按艺术家或专辑分组，分组键用 `compareText` 排序。
 * 空的分组键归入 `'未知'`，界面上不会出现一个没有标题的分组。
 */
export function groupBy<T extends SortableTrack>(
  tracks: readonly T[],
  key: 'artist' | 'album',
): Array<{ key: string; tracks: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const track of tracks) {
    const name = toText(track[key]).trim() || UNKNOWN;
    const bucket = buckets.get(name);
    if (bucket) bucket.push(track);
    else buckets.set(name, [track]);
  }

  return [...buckets.keys()]
    .sort(compareText)
    .map((name) => ({ key: name, tracks: buckets.get(name)! }));
}

/** 分组视图里的一行：要么是分组头，要么是曲目。 */
export type ListEntry<T> =
  | { kind: 'header'; groupKey: string; count: number }
  | { kind: 'track'; track: T };

/**
 * 把分组结果摊平成「混合行」列表：分组头与曲目在同一个数组里。
 *
 * 这样虚拟化可以继续用**固定行高**——不必为了分组头去引入可变行高的虚拟化库
 * （技术方案 7.1 留的那个抉择点）；分组头只是样式不同的普通一行。
 *
 * @param collapsed 已收起的分组键；收起的分组只保留分组头
 */
export function buildGroupedEntries<T extends SortableTrack>(
  tracks: readonly T[],
  key: 'artist' | 'album',
  collapsed: readonly string[] = [],
): Array<ListEntry<T>> {
  const collapsedSet = new Set(collapsed);
  const entries: Array<ListEntry<T>> = [];

  for (const group of groupBy(tracks, key)) {
    entries.push({ kind: 'header', groupKey: group.key, count: group.tracks.length });
    if (collapsedSet.has(group.key)) continue;
    for (const track of group.tracks) entries.push({ kind: 'track', track });
  }

  return entries;
}

/** 曲目列表 → 混合行（没有分组时每首一行），让界面只有一条渲染路径。 */
export function tracksToEntries<T extends SortableTrack>(tracks: readonly T[]): Array<ListEntry<T>> {
  return tracks.map((track) => ({ kind: 'track' as const, track }));
}
