import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * 应用构建（正式产品）。
 *
 * 用相对 base：PWA 装到桌面后是从本地文件/子路径加载的，绝对路径会 404。
 * Service Worker 只预缓存应用外壳（js/css/html/图标），**不缓存音频样本**——
 * 那些只是内置自检用的测试资源，塞进缓存只会白占空间。
 *
 * M0 的验证页有独立的配置，见 `vite.m0.config.ts`（`pnpm dev:m0`）。
 */
export default defineConfig({
  root,
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: '轻音播放',
        short_name: '轻音播放',
        description: '跑在浏览器里的本地音乐播放器：指向自己的音乐文件夹即可播放',
        lang: 'zh-CN',
        dir: 'ltr',
        theme_color: '#0b0d10',
        background_color: '#0b0d10',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['**/*.flac', '**/*.mp3', '**/*.ape'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
  },
});
