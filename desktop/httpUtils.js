'use strict';

const path = require('node:path');

/**
 * 静态服务与 app:// 协议共用的小工具：MIME、路径 containment、Range 解析。
 *
 * Range 支持不是"锦上添花"：`<audio>` 拖进度条时 Chromium 会发 `Range: bytes=...`，
 * 服务端不认就退化成"把整首歌读进内存"或者"拖不动"。
 * 桌面端将来很可能直接用 URL 播放本地文件（见 README 的 fs 桥设计），所以这里一次做对。
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ape': 'application/octet-stream',
  '.lrc': 'text/plain; charset=utf-8',
};

function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 路径 containment 检查。
 *
 * 必须先 `path.resolve` 再比前缀，而且要带上分隔符：
 * 只比 `startsWith(root)` 会让 `D:\dist-evil` 通过 `D:\dist` 的检查。
 */
function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep)
  );
}

/**
 * 解析 `Range: bytes=start-end`。
 *
 * 只处理单区间（`bytes=a-b` / `bytes=a-` / `bytes=-N`），多区间对本地播放没有意义。
 * 返回 null 表示"请求没带 Range 或者格式不认识"（按 200 全量响应）；
 * 返回 { unsatisfiable: true } 表示区间越界，要用 416 回。
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6).split(',')[0].trim();
  if (!/^(\d*-\d*)$/.test(spec)) return null;

  const dash = spec.indexOf('-');
  const rawStart = spec.slice(0, dash);
  const rawEnd = spec.slice(dash + 1);

  let start;
  let end;
  if (rawStart === '') {
    // 后缀区间：最后 N 个字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isFinite(start) || start < 0) return null;
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(end)) return null;
  }

  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 缓存策略。
 *
 * `assets/` 下的文件名带内容哈希，可以放心 immutable；
 * `index.html` / `sw.js` / manifest 必须每次问服务器，
 * 否则升级之后用户拿到的还是旧外壳（这个坑在 PWA 上已经踩过一次，见 src/ui/pwa.ts 的注释）。
 */
function cacheControlFor(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

module.exports = { MIME, mimeOf, isInside, parseRange, cacheControlFor };
