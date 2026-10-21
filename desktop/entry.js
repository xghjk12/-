'use strict';

/**
 * desktop/ 的唯一入口（desktop/package.json 的 main 指向这里）。
 *
 * 为什么要多这一层，而不是直接把 main.js 当入口：
 * 启动方式决定了 `app.getName()` / `app.getVersion()` 读到什么——
 *  - `electron desktop`（**目录**）→ 读 desktop/package.json → 名字是我们的，版本是 0.1.0
 *  - `electron desktop/main.js`（文件）→ 读不到 package.json → 名字变成 "Electron"，
 *    版本变成 **Electron 自己的 44.9.1**（实测），"关于/版本号"那一栏就会是错的
 * 实现阶段要做版本号，所以统一用目录方式启动。
 *
 * `--probe` 走 origin 持久性实验的探针，否则走正常启动。
 */
if (process.argv.includes('--probe')) {
  require('./probe.js');
} else {
  require('./main.js');
}
