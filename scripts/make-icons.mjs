#!/usr/bin/env node
/**
 * 生成 PWA 图标（`pnpm icons`）。
 *
 * 为什么自己画而不是随便放一张图：Chrome 的「可安装」判定要求 manifest 里至少有
 * 192×192 与 512×512 的位图图标，而本机没有 ffmpeg 的 PNG 编码器、也不想为一个图标
 * 引入图像库。于是用 node:zlib 手写一个最小 PNG 编码器，再在 4 倍超采样的像素缓冲上
 * 画一个圆角方块 + 八分音符，最后降采样得到带抗锯齿的图标。
 *
 * 产物提交进仓库（`public/icons/`），因为它是静态资源，不该让每次构建都依赖这个脚本。
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');

/* ==================== 最小 PNG 编码器 ==================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** RGBA8 像素缓冲 → PNG。 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ==================== 极简光栅器 ==================== */

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4, 0) };
}

/** 把颜色以 alpha 混合到某个像素上（源覆盖）。 */
function blend(canvas, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || alpha <= 0) return;
  const offset = (y * canvas.size + x) * 4;
  const dstA = canvas.data[offset + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  canvas.data[offset] = Math.round((r * alpha + canvas.data[offset] * dstA * (1 - alpha)) / outA);
  canvas.data[offset + 1] = Math.round(
    (g * alpha + canvas.data[offset + 1] * dstA * (1 - alpha)) / outA,
  );
  canvas.data[offset + 2] = Math.round(
    (b * alpha + canvas.data[offset + 2] * dstA * (1 - alpha)) / outA,
  );
  canvas.data[offset + 3] = Math.round(outA * 255);
}

/** 圆角矩形，颜色按纵向渐变给出。 */
function fillRoundRect(canvas, x0, y0, x1, y1, radius, colorAt) {
  for (let y = Math.floor(y0); y < y1; y += 1) {
    for (let x = Math.floor(x0); x < x1; x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius - 1));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius - 1));
      if (dx * dx + dy * dy > radius * radius) continue;
      blend(canvas, x, y, colorAt((y - y0) / (y1 - y0)), 1);
    }
  }
}

function fillEllipse(canvas, cx, cy, rx, ry, color) {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y += 1) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x += 1) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      blend(canvas, x, y, color, 1);
    }
  }
}

/** 扫描线填充凸多边形（图标里的符尾用它画）。 */
function fillPolygon(canvas, points, color) {
  const ys = points.map(([, y]) => y);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y += 1) {
    const crossings = [];
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      const scan = y + 0.5;
      if (y1 === y2 || scan < Math.min(y1, y2) || scan >= Math.max(y1, y2)) continue;
      crossings.push(x1 + ((scan - y1) / (y2 - y1)) * (x2 - x1));
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      for (let x = Math.ceil(crossings[i]); x <= Math.floor(crossings[i + 1]); x += 1) {
        blend(canvas, x, y, color, 1);
      }
    }
  }
}

/* ==================== 图标绘制 ==================== */

const BG_TOP = [70, 195, 156];
const BG_BOTTOM = [38, 133, 108];
const NOTE = [247, 252, 250];

function drawIcon(size) {
  const scale = 4;
  const canvas = createCanvas(size * scale);
  const s = canvas.size;

  // 圆角方块 + 纵向渐变
  fillRoundRect(canvas, 0, 0, s, s, s * 0.22, (t) => [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
  ]);

  // 八分音符：符头 + 符干 + 符尾
  fillEllipse(canvas, s * 0.4, s * 0.7, s * 0.13, s * 0.098, NOTE);
  fillRoundRect(canvas, s * 0.5, s * 0.27, s * 0.56, s * 0.71, s * 0.02, () => NOTE);
  fillPolygon(
    canvas,
    [
      [s * 0.552, s * 0.275],
      [s * 0.72, s * 0.36],
      [s * 0.72, s * 0.47],
      [s * 0.552, s * 0.385],
    ],
    NOTE,
  );

  // 降采样（盒式滤波）得到抗锯齿结果
  const out = createCanvas(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const offset = ((y * scale + dy) * s + (x * scale + dx)) * 4;
          r += canvas.data[offset];
          g += canvas.data[offset + 1];
          b += canvas.data[offset + 2];
          a += canvas.data[offset + 3];
        }
      }
      const count = scale * scale;
      const offset = (y * size + x) * 4;
      out.data[offset] = Math.round(r / count);
      out.data[offset + 1] = Math.round(g / count);
      out.data[offset + 2] = Math.round(b / count);
      out.data[offset + 3] = Math.round(a / count);
    }
  }

  return encodePng(size, size, out.data);
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#46c39c" />
      <stop offset="1" stop-color="#26856c" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)" />
  <ellipse cx="25.6" cy="44.8" rx="8.3" ry="6.3" fill="#f7fcfa" />
  <rect x="32" y="17.3" width="3.8" height="28.2" rx="1.3" fill="#f7fcfa" />
  <path d="M35.3 17.6 46 23l0 7-10.7-5.4z" fill="#f7fcfa" />
</svg>
`;

await mkdir(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  await writeFile(file, drawIcon(size));
  console.log(`生成 ${path.relative(root, file)}`);
}
await writeFile(path.join(root, 'public', 'favicon.svg'), FAVICON);
console.log('生成 public/favicon.svg');
