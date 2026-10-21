'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, nativeImage } = require('electron');
const { APP_NAME } = require('./constants.js');

/**
 * 主窗口。
 *
 * webPreferences 这几项是安全底线，别为了省事改动：
 *  - `contextIsolation: true` + `sandbox: true`：渲染进程里没有 Node，只有 preload 暴露的那几个函数
 *  - `nodeIntegration: false`：同上
 *  - `setWindowOpenHandler` 一律 deny：本地播放器不该弹出新窗口，
 *    也不能让页面里的一个链接把整个窗口导航到外部站点
 */
function createMainWindow(options) {
  const { distDir, show = true, width = 1440, height = 1000 } = options;

  const iconPath = path.join(distDir, 'icons', 'icon-192.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  const win = new BrowserWindow({
    title: APP_NAME,
    width,
    height,
    minWidth: 900,
    minHeight: 600,
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
