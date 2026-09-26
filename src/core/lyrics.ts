/**
 * 歌词解析与定位（纯逻辑，不引用任何平台 API）。
 *
 * 支持的真实世界形态：
 *  - 标准 LRC：`[mm:ss.xx]`，一行挂多个时间戳（`[00:10.00][01:20.00]同一句`）
 *  - 老式写法：`[mm:ss:xx]`（最后一段用冒号），时长与小数混用
 *  - 元数据标签：`[ti:] [ar:] [al:] [by:] [offset:]`
 *  - 增强型逐字：`<mm:ss.xx>`（**解析进模型但这一版只按行高亮**，以后升级不必重解析）
 *  - 完全没有时间轴的纯文本歌词：退化成"能显示但不跟随"
 *
 * 明确不做：在线抓取、逐字渲染、翻译与罗马音。见产品技术文档 4 节。
 *
 * 编码这块比 ID3 好办：歌词文件几乎整篇是文本，所以**先按 UTF-8 严格解码，失败再退 GBK**，
 * 比 `tagEncoding` 里那套"乱码特征检测"更准，也更容易解释。
 */

export interface LyricWord {
  timeSec: number;
  text: string;
}

export interface LyricLine {
  timeSec: number;
  text: string;
  /** 增强型 LRC 的逐字时间；没有就是 undefined。 */
  words?: LyricWord[];
}

export interface Lyrics {
  /** 按时间升序；没有时间轴时为空数组。 */
  lines: LyricLine[];
  /** 没有时间轴的文本行（保留原顺序，去掉纯空行）。 */
  plainLines: string[];
  /** `[offset:]` 标签值（毫秒 → 秒），正值表示歌词整体提前出现。 */
  offsetSec: number;
  title?: string;
  artist?: string;
  album?: string;
  by?: string;
  /** 是否带时间轴。 */
  synced: boolean;
}

/** 时间戳：[分:秒]、[分:秒.小数] 或 [分:秒:小数]。 */
const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
/** 元数据标签。 */
const METADATA = /^\[(ti|ar|al|by|offset|re|ve|length):\s*(.*?)\s*\]$/i;
/** 增强型 LRC 的逐字标签。 */
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** 把 `分` / `分.小数` / `分:小数` 折算成秒。 */
function toSeconds(minutes: string, seconds: string, fraction?: string): number {
  const base = Number(minutes) * 60 + Number(seconds);
  if (!fraction) return base;
  // 1 位=十分之一秒，2 位=百分之一秒，3 位=毫秒
  return base + Number(fraction) / 10 ** fraction.length;
}

function parseWords(text: string): { text: string; words?: LyricWord[] } {
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(text)) return { text: text.trim() };

  const words: LyricWord[] = [];
  let lastIndex = 0;
  let pendingTime: number | undefined;
  let buffer = '';

  WORD_TAG.lastIndex = 0;
  let match = WORD_TAG.exec(text);
  while (match !== null) {
    const between = text.slice(lastIndex, match.index);
    if (pendingTime === undefined) {
      buffer += between;
    } else {
      words.push({ timeSec: pendingTime, text: between });
    }
    pendingTime = toSeconds(match[1]!, match[2]!, match[3]);
    lastIndex = match.index + match[0].length;
    match = WORD_TAG.exec(text);
  }
  const tail = text.slice(lastIndex);
  if (pendingTime !== undefined) words.push({ timeSec: pendingTime, text: tail });
  else buffer += tail;

  return {
    text: (buffer + words.map((word) => word.text).join('')).trim(),
    words: words.length > 0 ? words : undefined,
  };
}

/**
 * 解析歌词文本。任何输入都不会抛异常——最差情况是"当成纯文本"。
 */
export function parseLyrics(text: string): Lyrics {
  const lyrics: Lyrics = { lines: [], plainLines: [], offsetSec: 0, synced: false };
  if (!text) return lyrics;

  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // 元数据标签：整行就是一个标签
    const metadata = METADATA.exec(line);
    if (metadata) {
      const key = metadata[1]!.toLowerCase();
      const value = metadata[2] ?? '';
      if (key === 'ti') lyrics.title = value || undefined;
      else if (key === 'ar') lyrics.artist = value || undefined;
      else if (key === 'al') lyrics.album = value || undefined;
      else if (key === 'by') lyrics.by = value || undefined;
      else if (key === 'offset') {
        const offset = Number(value);
        if (Number.isFinite(offset)) lyrics.offsetSec = offset / 1000;
      }
      continue;
    }

    // 行首的一个或多个时间戳
    TIMESTAMP.lastIndex = 0;
    const stamps: number[] = [];
    let cursor = 0;
    let match = TIMESTAMP.exec(line);
    while (match !== null && match.index === cursor) {
      stamps.push(toSeconds(match[1]!, match[2]!, match[3]));
      cursor = match.index + match[0].length;
      match = TIMESTAMP.exec(line);
    }

    if (stamps.length === 0) {
      // 没有时间戳：纯文本歌词（或夹在中间的说明文字）
      lyrics.plainLines.push(parseWords(line).text);
      continue;
    }

    const { text: content, words } = parseWords(line.slice(cursor));
    for (const timeSec of stamps) {
      lyrics.lines.push(words ? { timeSec, text: content, words } : { timeSec, text: content });
    }
  }

  // 时间戳可能乱序（手工编辑过的歌词很常见），排一下才能二分
  lyrics.lines.sort((a, b) => a.timeSec - b.timeSec);
  lyrics.synced = lyrics.lines.length > 0;
  return lyrics;
}

/**
 * 当前该显示第几行；没有可显示的返回 -1。
 *
 * @param offsetSec 正值表示歌词**提前**出现（`[offset:]` 与用户微调相加后传进来）
 */
export function currentLineIndex(
  lines: readonly LyricLine[],
  positionSec: number,
  offsetSec = 0,
): number {
  if (lines.length === 0) return -1;
  const target = positionSec + offsetSec;

  // 第一句还没到
  if (target < lines[0]!.timeSec) return -1;

  // 二分找最后一个 timeSec <= target
  let low = 0;
  let high = lines.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.timeSec <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** 把歌词转成可复制的纯文本（用于"复制歌词"）。 */
export function lyricsToText(lyrics: Lyrics): string {
  if (!lyrics.synced) return lyrics.plainLines.join('\n');
  return lyrics.lines
    .map((line) => line.text)
    .filter((text) => text.length > 0)
    .join('\n');
}

/** 是否是歌词文件（`.lrc`，大小写不敏感）。 */
export function isLyricFileName(fileName: string): boolean {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.toLowerCase().endsWith('.lrc');
}

/* ==================== 编码 ==================== */

/** 注入式解码器：拿不到对应编码时返回 undefined。 */
export type LyricDecoder = (bytes: Uint8Array, label: string, fatal: boolean) => string | undefined;

function defaultDecoder(bytes: Uint8Array, label: string, fatal: boolean): string | undefined {
  const TextDecoderCtor = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
  if (!TextDecoderCtor) return undefined;
  try {
    return new TextDecoderCtor(label, { fatal }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 解码歌词字节。
 *
 * 顺序：BOM（UTF-8 / UTF-16）→ UTF-8 严格 → GBK → UTF-8 宽松。
 * 中文 `.lrc` 大量是 GBK，而"严格 UTF-8 能解通"几乎可以断定就是 UTF-8，所以这个顺序足够稳。
 */
export function decodeLyrics(bytes: Uint8Array, decode: LyricDecoder = defaultDecoder): string {
  if (bytes.length === 0) return '';

  // BOM 优先，它是最明确的信号
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decode(bytes.subarray(3), 'utf-8', false) ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decode(bytes.subarray(2), 'utf-16le', false) ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decode(bytes.subarray(2), 'utf-16be', false) ?? '';
  }

  const strictUtf8 = decode(bytes, 'utf-8', true);
  if (strictUtf8 !== undefined) return strictUtf8;

  const gbk = decode(bytes, 'gbk', false);
  if (gbk !== undefined && !gbk.includes('\uFFFD')) return gbk;

  return decode(bytes, 'utf-8', false) ?? '';
}

/* ==================== 搜索跳转（方案 B） ==================== */

/** 支持 `{title} {artist} {album} {trackNo} {keyword}`。 */
export interface LyricSearchTrack {
  title: string;
  artist?: string;
  album?: string;
  trackNo?: number;
}

/**
 * 校验地址模板。
 *
 * **只接受 http / https**：模板是用户可编辑的，`javascript:` 之类的地址一旦被 `window.open`
 * 打开就是一个注入口子。宁可拒绝，也不做"看起来聪明"的兼容。
 */
export function isSafeSearchTemplate(template: string): boolean {
  const trimmed = template.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed.replace(/\{[a-zA-Z]+\}/g, 'x'));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 默认的搜索关键词：艺术家 + 标题。 */
export function lyricSearchKeyword(track: LyricSearchTrack): string {
  return [track.artist, track.title].filter(Boolean).join(' ').trim();
}

/**
 * 按模板拼出搜索地址；模板为空、不合法或没有占位符时返回 undefined。
 *
 * 注意：应用**只负责拼这一条 URL 并交给浏览器打开**，不会去请求它，也不会解析返回内容。
 */
export function buildLyricSearchUrl(
  template: string,
  track: LyricSearchTrack,
): string | undefined {
  if (!isSafeSearchTemplate(template)) return undefined;
  if (!/\{[a-zA-Z]+\}/.test(template)) return undefined;

  const values: Record<string, string> = {
    title: track.title ?? '',
    artist: track.artist ?? '',
    album: track.album ?? '',
    trackNo: track.trackNo === undefined ? '' : String(track.trackNo),
    keyword: lyricSearchKeyword(track),
  };

  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    name in values ? encodeURIComponent(values[name]!) : whole,
  );
}
