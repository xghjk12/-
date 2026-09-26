import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // demo/ 下的 *.test.cjs 用的是 node:test，不走 vitest
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-m0/**', 'demo/**'],
    // 解析真实音频文件、必要时还要回退读整文件
    testTimeout: 30_000,
  },
});
