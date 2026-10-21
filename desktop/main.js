'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const constants = require('./constants.js');
const { installDesktopIpc } = require('./mainIpc.js');
const { createStaticServer } = require('./staticServer.js');
const { pinUserData } = require('./userData.js');
const { createMainWindow } = require('./window.js');

/**
 * 桌面端入口（探路阶段的最小版本）。
 *
 * 启动顺序有讲究：
 *  1. **ready 之前**把 userData 钉死（见 constants.js 的 APP_ID 注释）
 *  2. ready 之后先起本地静态服务，再开窗加载 `http://127.0.0.1:53140/`
 *     —— 绝不用 `file://`：那样 origin 是 opaque(null)，IndexedDB 不可用，用户数据等于不存在
 *  3. 单实例锁：两个实例抢同一个固定端口没有意义，第二个实例应该把第一个唤到前台
 *
 * 托盘 / 关窗继续放歌 / 开机自启都不在这里——那是实现阶段的事。
 * 现在 `window-all-closed` 就是退出。
 */

// ---- ready 之前：钉死身份与数据目录（顺序不能动，详见 userData.js 的注释）----
const userDataChoice = pinUserData();

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, constants.DIST_DIRNAME);

let mainWindow = null;
let staticServer = null;

function fail(title, detail) {
  // showErrorBox 不依赖窗口，ready 前后都能用
  dialog.showErrorBox(title, detail);
  app.exit(1);
}

function ensureDist() {
  const indexHtml = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    fail(
      '找不到前端构建产物',
      `期望在 ${indexHtml} 找到 index.html。\n\n先在仓库根目录执行：\n  node node_modules/vite/bin/vite.js build\n（或 pnpm build），然后再启动桌面端。`,
    );
    return false;
  }
  return true;
}

async function boot() {
  if (!ensureDist()) return;

  staticServer = createStaticServer({
    root: distDir,
    onLog: (event) => console.log(`[static] ${event.level}: ${event.message}`),
  });

  try {
    await staticServer.listen();
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      fail(
        `端口 ${constants.PORT} 已被占用`,
        `轻音播放的桌面端固定使用 ${constants.ORIGIN} 作为 origin：\n` +
          '换端口等于换 origin，IndexedDB 里的曲库缓存与播放状态会"凭空消失"，\n' +
          '所以这里不会自动改端口。\n\n' +
          `请先查一下是谁占着：netstat -ano | findstr :${constants.PORT}\n` +
          '如果占用者就是另一个轻音播放实例，请先完全退出它（含托盘）。',
      );
      return;
    }
    throw error;
  }

  installDesktopIpc({
    origin: staticServer.origin,
    port: staticServer.port,
    token: staticServer.token,
    startedAt: new Date().toISOString(),
  });

  console.log(`[desktop] origin = ${staticServer.origin}`);
  console.log(`[desktop] userData = ${app.getPath('userData')}`);
  if (userDataChoice.fellBack) {
    // 降级必须说出来：数据不在系统默认位置，用户（和后来排障的人）有权知道
    console.warn(`[desktop] 警告：${userDataChoice.reason}`);
    console.warn(`[desktop] 已改用备用数据目录：${userDataChoice.dir}`);
  }

  mainWindow = createMainWindow({ distDir });
  await mainWindow.loadURL(`${staticServer.origin}/`);
  mainWindow.show();
}

// ---- 单实例：固定端口下，第二个实例只会撞端口 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    void boot().catch((error) => {
      fail('桌面端启动失败', error instanceof Error ? (error.stack ?? error.message) : String(error));
    });
  });

  app.on('window-all-closed', () => {
    // 探路阶段：关窗即退。实现阶段会改成"关窗进托盘，继续放歌"。
    app.quit();
  });

  app.on('will-quit', () => {
    void staticServer?.close();
  });
}
