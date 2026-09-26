/**
 * 音频格式分类。纯逻辑，不引用任何浏览器或 Node API。
 *
 * 之所以要在解析之前就分类，是 M0 实测得出的结论：music-metadata 支持的格式远多于
 * Chromium 能解码的格式——APE / WavPack / DSD 都读得出标签，却放不出声音；反过来，
 * 遇到损坏文件时 music-metadata 抛出的是 EndOfStreamError / CouldNotDetermineFileTypeError
 * 这类底层错误，没有干净的"不支持"信号。产品文档要求这类文件"明确标记为不支持而非静默失败"，
 * 所以判定必须由我们自己给出。
 */

/** `decodable` 能播；`metadata-only` 只能展示信息。 */
export type PlaybackVerdict = 'decodable' | 'metadata-only';

export interface FormatVerdict {
  extension: string;
  verdict: PlaybackVerdict;
  /** 需要向用户解释时给出的短说明。 */
  note?: string;
  /** 该容器可能装着无法解码的编码（如 m4a 里的 ALAC），解析出 codec 后需要复核。 */
  codecSensitive?: boolean;
}

/** Chromium 能直接解码播放的音频扩展名。 */
const DECODABLE = new Set([
  'mp3', 'flac', 'wav', 'wave', 'm4a', 'mp4', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'webm',
]);

/** Chromium 放不出声，但 music-metadata 仍能读出标签，因此可以列表展示。 */
const METADATA_ONLY = new Set([
  'ape', 'wv', 'dsf', 'dff', 'wma', 'asf', 'mpc', 'aif', 'aiff', 'aifc', 'tta', 'spx', 'mka',
]);

/** 已知无法解码的编码名，按子串匹配 music-metadata 给出的 format.codec。 */
const UNDECODABLE_CODECS = ['alac', 'monkey', 'wavpack', 'dsd', 'musepack', 'wma'];

/** 取小写扩展名（不含点）。路径分隔符兼容 `\` 与 `/`。 */
export function extensionOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 非音频文件返回 null。 */
export function classifyAudioFile(fileName: string): FormatVerdict | null {
  const extension = extensionOf(fileName);
  if (DECODABLE.has(extension)) {
    const result: FormatVerdict = { extension, verdict: 'decodable' };
    if (extension === 'm4a' || extension === 'mp4' || extension === 'm4b') {
      result.codecSensitive = true;
    }
    return result;
  }
  if (METADATA_ONLY.has(extension)) {
    return {
      extension,
      verdict: 'metadata-only',
      note: '浏览器无法解码该格式，可以查看曲目信息但不能播放',
    };
  }
  return null;
}

export function isAudioFileName(fileName: string): boolean {
  return classifyAudioFile(fileName) !== null;
}

/** 解析出 codec 之后复核判定，例如 .m4a 里装的其实是 ALAC。 */
export function resolveVerdict(base: FormatVerdict, codec?: string): FormatVerdict {
  if (!base.codecSensitive || !codec) return base;
  const lower = codec.toLowerCase();
  if (UNDECODABLE_CODECS.some((name) => lower.includes(name))) {
    return {
      extension: base.extension,
      verdict: 'metadata-only',
      note: `容器内编码为 ${codec}，浏览器无法解码`,
    };
  }
  return base;
}
