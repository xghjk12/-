/**
 * 歌词文件与曲目的自动匹配（纯逻辑）。
 *
 * 真实音乐库里的歌词文件名五花八门，这个模块把常见形态都吃掉，但**歧义一律不猜**：
 *
 * | 音频 | 歌词 | 判定 |
 * | --- | --- | --- |
 * | `01 青花瓷.flac` | `01 青花瓷.lrc` | 同名 |
 * | `01 青花瓷.flac` | `青花瓷.lrc` | 去掉音轨号后同名 |
 * | `青花瓷.flac` | `周杰伦 - 青花瓷.lrc` | 艺术家 + 标题 |
 * | `01 青花瓷.flac` | `专辑/lyrics/01 青花瓷.lrc` | `lyrics` 子目录里按同样规则 |
 *
 * 匹配不上的、以及"一个歌词对上好几首"或"一首歌有好几个歌词"的，都不做自动关联，
 * 交给手动导入/拖入（界面上会提示有多少个没认领）。
 */
import { baseName, stripExtension } from './library.js';

export interface LyricFileRef {
  /** 相对曲库根目录的 posix 路径。 */
  path: string;
  name: string;
}

export interface LyricTarget {
  path: string;
  name: string;
  title: string;
  artist?: string;
  album?: string;
}

export type LyricMatchReason = 'same-name' | 'track-number' | 'artist-title' | 'title-only';

export interface LyricAssignment {
  trackPath: string;
  lyricPath: string;
  reason: LyricMatchReason;
  score: number;
}

export interface LyricMatchResult {
  assignments: LyricAssignment[];
  /** 目录下找不到对应曲目的歌词。 */
  unmatched: LyricFileRef[];
  /** 有多个同分候选，或与别的歌词抢同一首歌——都不自动关联。 */
  ambiguous: LyricFileRef[];
}

/** 视为"歌词目录"的文件夹名（小写比较）。 */
const LYRICS_DIRS = new Set(['lyrics', 'lyric', 'lrc', '歌词', '歌词文件']);

function dirOf(posixPath: string): string {
  const normalized = posixPath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

/**
 * 匹配用的规范化：去扩展名、转小写、统一各种连接符、**把空白折成 `-`**。
 *
 * 为什么不直接把空白删掉：`01 青花瓷` 删空白后是 `01青花瓷`，音轨号与标题之间的边界就没了，
 * 后面 `stripTrackNumber` 没法判断该不该去掉 `01`。折成 `-` 之后 `01-青花瓷` 边界清晰，
 * 而且 `周杰伦 青花瓷` 与 `周杰伦 - 青花瓷` 会归一成同一个形状，正好把人工整理的两种写法统一起来。
 */
export function normalizeForMatch(value: string): string {
  return stripExtension(baseName(value))
    .toLowerCase()
    .replace(/[－–—−]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 去掉开头的音轨号。
 *
 * 只在"数字后面跟分隔符"时才去掉（规范化之后空白也是 `-`），所以 `24小时` 这种以数字开头的
 * 标题不会被误伤；`01 青花瓷` / `01.青花瓷` / `01-青花瓷` 会被正确去掉。
 * 边界情形（`24 小时`）无法与音轨号区分，按音轨号处理。
 */
export function stripTrackNumber(value: string): string {
  return value.replace(/^\d{1,3}[-._·]/, '');
}

export function isLyricsDir(dir: string): boolean {
  const segment = dir.split('/').filter(Boolean).pop() ?? '';
  return LYRICS_DIRS.has(segment.toLowerCase());
}

interface Scored {
  target: LyricTarget;
  reason: LyricMatchReason;
  score: number;
}

/** 给"歌词 vs 曲目"打分；不匹配返回 undefined。分数只用来排序，不做加权。 */
function score(lyricName: string, target: LyricTarget): Scored | undefined {
  const stem = normalizeForMatch(lyricName);
  const stripped = stripTrackNumber(stem);

  const targetStem = normalizeForMatch(target.name);
  const targetStripped = stripTrackNumber(targetStem);
  const title = normalizeForMatch(target.title);
  const titleStripped = stripTrackNumber(title);
  const artist = target.artist ? normalizeForMatch(target.artist) : '';

  if (stem && stem === targetStem) return { target, reason: 'same-name', score: 100 };
  if (stripped && stripped === targetStripped) {
    return { target, reason: 'track-number', score: 90 };
  }

  if (artist) {
    const pairs = [`${artist}-${title}`, `${title}-${artist}`];
    if (pairs.includes(stem) || pairs.includes(stripped)) {
      return { target, reason: 'artist-title', score: 85 };
    }
  }

  if (titleStripped && (stripped === titleStripped || stem === titleStripped)) {
    return { target, reason: 'title-only', score: 80 };
  }

  return undefined;
}

/**
 * 把歌词文件分配到曲目上。
 *
 * 目录是硬边界：只在同一个目录（或该目录下的 `lyrics` 子目录）里找候选，
 * 这样"两张专辑各有一首 `01 序曲`"不会互相串。
 */
export function matchLyrics(
  targets: readonly LyricTarget[],
  lyrics: readonly LyricFileRef[],
): LyricMatchResult {
  const byDir = new Map<string, LyricTarget[]>();
  for (const target of targets) {
    const dir = dirOf(target.path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(target);
    else byDir.set(dir, [target]);
  }

  const assignments: LyricAssignment[] = [];
  const unmatched: LyricFileRef[] = [];
  const ambiguous: LyricFileRef[] = [];

  for (const lyric of lyrics) {
    const dir = dirOf(lyric.path);
    // 歌词放在 lyrics/ 子目录里时，回到上一层去找曲目
    const baseDir = isLyricsDir(dir) ? dirOf(dir) : dir;
    const candidates = byDir.get(baseDir) ?? [];

    let best: Scored | undefined;
    let tie = false;

    for (const target of candidates) {
      const scored = score(lyric.name, target);
      if (!scored) continue;
      if (!best || scored.score > best.score) {
        best = scored;
        tie = false;
      } else if (scored.score === best.score) {
        tie = true;
      }
    }

    if (!best) unmatched.push(lyric);
    else if (tie) ambiguous.push(lyric);
    else {
      assignments.push({
        trackPath: best.target.path,
        lyricPath: lyric.path,
        reason: best.reason,
        score: best.score,
      });
    }
  }

  // 一首歌被多个歌词命中：全部撤回，别猜哪个对
  const countByTrack = new Map<string, number>();
  for (const assignment of assignments) {
    countByTrack.set(assignment.trackPath, (countByTrack.get(assignment.trackPath) ?? 0) + 1);
  }

  const kept: LyricAssignment[] = [];
  for (const assignment of assignments) {
    if ((countByTrack.get(assignment.trackPath) ?? 0) > 1) {
      const lyric = lyrics.find((item) => item.path === assignment.lyricPath);
      if (lyric) ambiguous.push(lyric);
      continue;
    }
    kept.push(assignment);
  }

  kept.sort((a, b) => (a.trackPath < b.trackPath ? -1 : a.trackPath > b.trackPath ? 1 : 0));
  return { assignments: kept, unmatched, ambiguous };
}
