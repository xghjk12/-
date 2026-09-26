/**
 * 曲库的纯逻辑：缓存键、路径归一化、标题回退。不引用任何平台 API。
 */

export interface FileIdentity {
  /** 相对曲库根目录的路径，posix 分隔符。 */
  readonly path: string;
  readonly size: number;
  readonly lastModified: number;
}

/**
 * 缓存键 = 路径 + 大小 + 修改时间（产品文档 5.3）。
 *
 * 用 NUL 分隔而不是 `-` 或 `:`：路径本身可能包含任何可见字符，用可见字符拼接会让
 * 不同文件撞到同一个键，而 NUL 不可能出现在路径里。
 */
export function cacheKey(identity: FileIdentity): string {
  return `${identity.path}\u0000${identity.size}\u0000${identity.lastModified}`;
}

/** 缓存是否命中：路径、大小、修改时间三者全等。 */
export function isCacheHit(cached: FileIdentity | undefined, current: FileIdentity): boolean {
  if (!cached) return false;
  return (
    cached.path === current.path &&
    cached.size === current.size &&
    cached.lastModified === current.lastModified
  );
}

/** 拼相对路径，统一成 posix 分隔符，保证不同平台上的缓存键一致。 */
export function joinRelativePath(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/\\/g, '/'))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/** 取路径最后一段。 */
export function baseName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? '';
}

/** 去掉最后一个扩展名。 */
export function stripExtension(fileName: string): string {
  const base = baseName(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 从文件名猜标题：去掉扩展名，并去掉常见的音轨号前缀（`01 - `、`01.`、`01_`、`01·`）。
 * 仅在文件没有任何标题标签时使用。
 */
export function guessTitle(fileName: string): string {
  const stem = stripExtension(fileName);
  const withoutTrackNo = stem.replace(/^\s*\d{1,3}\s*[-._·]\s*/, '');
  return withoutTrackNo.trim() || stem.trim() || fileName;
}
