'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, nativeImage } = require('electron');
const {
  APP_NAME,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} = require('./constants.js');

/**
 * 主窗口。
 *
 * webPreferences 这几项是安全底线，别为了省事改动：
 *  - `contextIsolation: true` + `sandbox: true`：渲染进程里没有 Node，只有 preload 暴露的那几个函数
 *  - `nodeIntegration: false`：同上
 *  - `setWindowOpenHandler` 一律 deny：本地播放器不该弹出新窗口，
 *    也不能让页面里的一个链接把整个窗口导航到外部站点
 *
 * 几何（t6）：`x`/`y` 传数字就用上次记住的位置，传 null/undefined 就交给系统居中。
 * 这里的 x/y **只接受调用方已经校验过的值**——屏幕外的坐标会在开机时造出一个
 * "打开了但看不见"的窗口，校验逻辑在 windowState.js（可单测），不在这。
 */
function createMainWindow(options) {
  const {
    distDir,
    show = true,
    width = WINDOW_DEFAULT_WIDTH,
    height = WINDOW_DEFAULT_HEIGHT,
    x = null,
    y = null,
    title = APP_NAME,
    minWidth = WINDOW_MIN_WIDTH,
    minHeight = WINDOW_MIN_HEIGHT,
  } = options;

  const iconPath = path.join(distDir, 'icons', 'icon-192.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  // x/y 只在两个都是合法数字时才传：只给一个会让 electron 用 0 补齐另一半
  const position =
    typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
      ? { x: Math.round(x), y: Math.round(y) }
      : {};

  const win = new BrowserWindow({
    title,
    width,
    height,
    ...position,
    minWidth,
    minHeight,
    show,
    icon,
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return win;
}

module.exports = { createMainWindow };
