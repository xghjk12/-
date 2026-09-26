import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * M0 专用构建：把 music-metadata 打成浏览器产物，用来验证
 * "music-metadata 在浏览器里到底能不能用、体积多大"（产品文档 8 的第一个风险）。
 *
 * M0 已通过，这个页面保留为手动验证入口（`pnpm dev:m0`），产物体积数字仍可复现。
 */
export default defineConfig({
  root: path.join(root, 'm0'),
  base: './',
  build: {
    outDir: path.join(root, 'dist-m0'),
    emptyOutDir: true,
    // 体积数据本身就是验证结论的一部分，不要压缩成一行
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
