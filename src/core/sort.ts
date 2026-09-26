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

/** 参与排序/检索的最小字段集合，Track 天然满足它。 */
export interface SortableTrack {
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
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
 * 子串匹配标题 / 艺术家 / 专辑，大小写不敏感，查询串两端空白忽略。
 * 空查询返回全部（依然是新数组）。
 */
export function filterTracks<T extends SortableTrack>(tracks: readonly T[], query: string): T[] {
  const needle = toText(query).trim().toLowerCase();
  if (!needle) return tracks.slice();
  return tracks.filter((track) => {
    return (
      toText(track.title).toLowerCase().includes(needle) ||
      toText(track.artist).toLowerCase().includes(needle) ||
      toText(track.album).toLowerCase().includes(needle)
    );
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
