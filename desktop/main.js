'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const constants = require('./constants.js');
const { readAppVersion } = require('./appVersion.js');
const { installDesktopIpc } = require('./mainIpc.js');
const { installLyricsIpc } = require('./lyricsIpc.js');
const { createStaticServer } = require('./staticServer.js');
const { pinUserData } = require('./userData.js');
const { createMainWindow } = require('./window.js');
const { createAppTray } = require('./tray.js');
const { loadSettings, saveSettings } = require('./shellSettings.js');
const { titleWithVersion, trayTooltip } = require('./shellText.js');
const {
  buildRunCommand,
  enableLoginItem,
  disableLoginItem,
  readLoginItemCommand,
  readLoginItemPresent,
} = require('./autoStart.js');

/**
 * 桌面端入口（t2：托盘 / 关窗到托盘继续放歌 / 单实例 / 开机自启 / 版本号）。
 *
 * 启动顺序有讲究：
 *  1. **ready 之前**把 userData 钉死（见 constants.js 的 APP_ID 注释）
 *  2. ready 之后先起本地静态服务，再开窗加载 `http://127.0.0.1:53140/`
 *     —— 绝不用 `file://`：那样 origin 是 opaque(null)，IndexedDB 不可用，用户数据等于不存在
 *  3. 单实例锁：两个实例抢同一个固定端口没有意义，第二个实例应该把第一个唤到前台
 *
 * 关窗到托盘的关键不变式：**close 一律拦截成 hide，渲染进程绝不能销毁**——
 * 音频在渲染进程里播，窗口一销毁音乐就停，托盘就成了空壳。真正的退出只有
 * 托盘菜单「退出」（和系统会话结束）两条路，走 isQuitting 标志放行。
 */

// ---- ready 之前：钉死身份与数据目录（顺序不能动，详见 userData.js 的注释）----
const userDataChoice = pinUserData();
// pinUserData 内部已经 setPath，这之后 getPath('userData') 才安全（坑 1）
const userDataDir = app.getPath('userData');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, constants.DIST_DIRNAME);

// 版本号唯一真相是仓库根 package.json；打包后（仓库不在了）才退回 app.getVersion()
const appVersion = readAppVersion(repoRoot) ?? app.getVersion();

// 更新提示位：本期明确不做自动更新（任务边界），恒 null。
// 将来接更新源时把这里换成检查结果，托盘 tooltip / 菜单预留项会自动跟上
// （trayMenu.js / shellText.js 里只有这一个分支消费它）。
let updateAvailable = null;

let mainWindow = null;
let staticServer = null;
let tray = null;
let settings = loadSettings(userDataDir);
let isQuitting = false;
// t5：补歌词工具控制器（boot 里由 installLyricsIpc 装配，托盘/IPC/退出共用）
let lyrics = null;

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

// ---- 窗口管理：关窗 = 进托盘 ----

function windowTitle() {
  return titleWithVersion(constants.APP_NAME, appVersion, constants.APP_NAME);
}

function createWindow() {
  const win = createMainWindow({ distDir, title: windowTitle() });
  mainWindow = win;

  // 关窗到托盘：**只隐藏，绝不销毁**（销毁 = 渲染进程死 = 音乐停）
  win.on('close', (event) => {
    if (isQuitting) return; // 真退出（托盘「退出」/系统会话结束）：放行
    event.preventDefault();
    win.hide();
    tray?.refresh();
  });

  // 意外销毁（渲染进程崩溃重启等）也不丢对象引用
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      tray?.refresh();
    }
  });

  // 页面自己会改标题（播放中显示「歌名 - 轻音播放」）：保留这个行为，
  // 只在末尾补版本号，让版本始终对用户可见
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(titleWithVersion(title, appVersion, constants.APP_NAME));
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 窗口没了（崩溃后的兜底路径）：重建一个
    createWindow();
    if (staticServer) {
      void mainWindow.loadURL(`${staticServer.origin}/`);
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  tray?.refresh();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  tray?.refresh();
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

// ---- 托盘 ----

function createTray() {
  const iconCandidates = [
    path.join(distDir, 'icons', 'icon-192.png'), // 构建产物
    path.join(repoRoot, 'public', 'icons', 'icon-192.png'), // 开发目录回退
  ];
  const iconPath = iconCandidates.find((candidate) => fs.existsSync(candidate));
  if (!iconPath) {
    // 没图标托盘就是隐形的：宁可起不来，也不能让"关窗到托盘"变成把窗口藏到找不到
    fail(
      '缺少托盘图标',
      `在 ${iconCandidates.join(' 或 ')} 都找不到 icon-192.png。\n\n` +
        '先在仓库根目录执行 pnpm build（或 node scripts/make-icons.mjs）。',
    );
    return;
  }
  tray = createAppTray({
    iconPath,
    appName: constants.APP_NAME,
    version: appVersion,
    getUpdateAvailable: () => updateAvailable,
    isVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    getOpenAtLogin: () => settings.openAtLogin,
    getLyricsToolState: () => (lyrics ? lyrics.status() : { status: 'idle' }),
    onToggleWindow: () => toggleMainWindow(),
    onShowWindow: () => showMainWindow(),
    onSetOpenAtLogin: (checked) => {
      // 菜单点击是同步回调：异步写盘，失败只记日志（托盘 UI 状态由 refresh 反映真实值）
      void setOpenAtLogin(checked).catch((error) => {
        console.error('[desktop] 设置开机自启失败：', error);
      });
    },
    onFillLyrics: () => {
      void lyrics?.startFill().then((result) => {
        if (!result.ok) {
          console.log(`[desktop] 补歌词未启动：${result.reason}`);
        } else {
          console.log(`[desktop] 补歌词已启动：${result.scriptPath} → ${result.musicPath}`);
        }
      });
    },
    onChooseMusicFolder: () => {
      void lyrics?.chooseMusicFolder().then((result) => {
        if (result?.changed) console.log(`[desktop] 补歌词音乐文件夹 = ${result.musicFolderPath}`);
      });
    },
    onChooseToolScript: () => {
      void lyrics?.chooseToolScript().then((result) => {
        if (result?.changed) console.log(`[desktop] 补歌词工具 = ${result.lyricsToolPath || '(内置脚本)'}`);
      });
    },
    onQuit: () => quitApp(),
  });
}

// ---- 开机自启 ----

function loginItemArgs() {
  if (app.isPackaged) return [];
  // 未打包时开机启动的是 electron.exe，必须带上应用目录；--no-sandbox 见 README 坑 2
  return [app.getAppPath(), '--no-sandbox'];
}

function loginItemCommand() {
  return buildRunCommand(process.execPath, loginItemArgs());
}

/**
 * 只读 OS 侧自启状态（不写任何东西）：托盘刷新/验证脚本用。
 * 读回策略与 applyLoginItem 相同：精确（export）优先，存在性（query）兜底。
 */
async function readOsLoginItem() {
  const options = { exePath: process.execPath, args: loginItemArgs(), name: constants.APP_ID };
  const expected = buildRunCommand(options.exePath, options.args);
  if (process.platform !== 'win32') {
    return {
      openAtLogin: app.getLoginItemSettings({ path: options.exePath, args: options.args }).openAtLogin === true,
      command: null,
      readMode: 'none',
    };
  }
  try {
    const command = await readLoginItemCommand(options);
    return { openAtLogin: command !== null && command === expected, command, readMode: 'exact' };
  } catch {
    // reg export（要写临时文件）被环境限制时：只查存在性
    const present = await readLoginItemPresent(options);
    return { openAtLogin: present, command: present ? expected : null, readMode: 'presence' };
  }
}

/**
 * 把 openAtLogin 同步给操作系统并读回。
 *
 * Windows 走自管的 HKCU Run 项（autoStart.js）：Electron 44.9.1 的
 * setLoginItemSettings 在本机实测静默失效（三变体全不落盘，见 README §8），
 * 自己写注册表才可控可验证。其他平台仍走官方 API（本仓库只在 Windows 验证过）。
 *
 * 读回策略：优先 reg export（精确命令比对）；export 被环境限制时退回
 * reg query 的存在性检查。写失败不抛给调用方（开关 UI 不该崩），只记日志——
 * settings.json 是 UI 状态真源，OS 侧下次切换时会再同步。
 *
 * @returns {Promise<{ openAtLogin: boolean, command: string | null, readMode: 'exact' | 'presence' | 'none' }>}
 */
async function applyLoginItem(openAtLogin) {
  const args = loginItemArgs();
  if (process.platform === 'win32') {
    const options = { exePath: process.execPath, args, name: constants.APP_ID };
    if (openAtLogin) {
      try {
        await enableLoginItem(options);
      } catch (error) {
        console.error(`[desktop] 注册表自启写入失败（不影响开关状态，下次切换会重试）：${error}`);
      }
    } else {
      await disableLoginItem(options);
    }
    // 读回以注册表为准（读策略见 readOsLoginItem）
    return readOsLoginItem();
  }
  app.setLoginItemSettings({ openAtLogin, path: process.execPath, args, name: constants.APP_ID });
  return {
    openAtLogin: app.getLoginItemSettings({ path: process.execPath, args }).openAtLogin === true,
    command: null,
    readMode: 'none',
  };
}

async function setOpenAtLogin(next) {
  settings = saveSettings(userDataDir, { openAtLogin: next === true });
  const osReadBack = await applyLoginItem(settings.openAtLogin);
  console.log(
    `[desktop] 开机自启 = ${settings.openAtLogin}（OS 读回 = ${osReadBack.openAtLogin}${osReadBack.readMode === 'presence' ? '，存在性模式' : ''}${osReadBack.command ? `，命令 = ${osReadBack.command}` : ''}）`,
  );
  tray?.refresh();
  return {
    settings: { ...settings },
    osOpenAtLogin: osReadBack.openAtLogin,
    readMode: osReadBack.readMode,
    command: osReadBack.command,
    settingsFile: path.join(userDataDir, 'settings.json'),
  };
}

// ---- 退出 ----

function quitApp() {
  isQuitting = true;
  app.quit();
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

  // t5：补歌词 IPC（lyrics:run/status/cancel）。目录选择对话框也从这里接，
  // 挂在 createWindow 之后 createTray 之前——托盘菜单的「补歌词…」从第一秒就能点。
  lyrics = installLyricsIpc({
    builtInScriptPath: path.join(repoRoot, 'desktop', 'tools', 'fill-lyrics.ps1'),
    getSettings: () => settings,
    saveSettingsPatch: (patch) => {
      settings = saveSettings(userDataDir, patch);
      return settings;
    },
    broadcast: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
    },
    onStateChanged: () => tray?.refresh(),
    pickMusicFolder: async (title) => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
        title,
        properties: ['openDirectory', 'promptToCreate'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    pickToolScript: async () => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
        title: '选择补歌词工具脚本（默认用内置的 desktop/tools/fill-lyrics.ps1）',
        filters: [
          { name: '脚本或可执行文件', extensions: ['ps1', 'bat', 'cmd', 'exe'] },
        ],
        properties: ['openFile'],
      });
      if (!result.canceled && result.filePaths[0]) {
        return { path: result.filePaths[0], reset: false };
      }
      // 取消时不动现有值；只有在已有自定义脚本时才问一句要不要恢复内置
      if (settings.lyricsToolPath) {
        const choice = await dialog.showMessageBox(mainWindow ?? undefined, {
          type: 'question',
          buttons: ['恢复内置脚本', '保持现状'],
          defaultId: 1,
          cancelId: 1,
          message: '要恢复用内置的补歌词脚本吗？',
          detail: `当前自定义脚本：${settings.lyricsToolPath}\n内置脚本走 artifacts\\lyricflow 的 LyricFlow（见仓库 README）。`,
        });
        return { path: null, reset: choice.response === 0 };
      }
      return { path: null, reset: false };
    },
  });

  console.log(`[desktop] origin = ${staticServer.origin}`);
  console.log(`[desktop] userData = ${app.getPath('userData')}`);
  console.log(`[desktop] 版本 = ${appVersion}（tooltip：${trayTooltip({ appName: constants.APP_NAME, version: appVersion, updateAvailable }).replace('\n', ' | ')}）`);
  if (userDataChoice.fellBack) {
    // 降级必须说出来：数据不在系统默认位置，用户（和后来排障的人）有权知道
    console.warn(`[desktop] 警告：${userDataChoice.reason}`);
    console.warn(`[desktop] 已改用备用数据目录：${userDataChoice.dir}`);
  }

  createWindow();
  await mainWindow.loadURL(`${staticServer.origin}/`);
  mainWindow.show();

  createTray();
  // 注意：这里不在启动时同步注册表（不做 boot 自愈）。原因：本机实测
  // Electron 主进程启动早期 spawn reg.exe 会直接把进程崩掉（README §8），
  // 开机自启的注册表写入只在用户切开关时发生（setOpenAtLogin），崩溃窗口
  // 不落在启动路径上；settings.json 才是 UI 状态的唯一真源。
}

// ---- 单实例：固定端口下，第二个实例只会撞端口 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 关窗进托盘后音乐还在放：再点一次图标/快捷方式应该把窗口唤回来，
    // 而不是把正在放歌的实例干掉、也不是再开一个窗口
    showMainWindow();
  });

  app.whenReady().then(() => {
    void boot().catch((error) => {
      fail('桌面端启动失败', error instanceof Error ? (error.stack ?? error.message) : String(error));
    });
  });

  app.on('before-quit', () => {
    // quit 从任何路径来（托盘退出、app.quit()、系统会话结束）都先把闸门打开
    isQuitting = true;
  });

  app.on('session-end', () => {
    // Windows 系统关机/注销：让 close 放行，别让 preventDefault 挡关机
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    if (isQuitting) return;
    // 正常关窗走不到这里（close 被拦截成 hide）。走到这里说明窗口真的没了
    // （渲染进程崩溃等）。不退出：托盘还在，点「显示窗口」会重建窗口，
    // 用户的后台进程与曲库不该跟着消失。
    console.warn('[desktop] 所有窗口已关闭（意外路径），保留托盘，可从托盘重新打开窗口');
    tray?.refresh();
  });

  app.on('will-quit', () => {
    tray?.destroy();
    void staticServer?.close();
    // t5：退出时把正在跑的补歌词工具整棵进程树杀掉——不杀的话
    // python 会变孤儿继续下载，用户视角是"退了应用还在偷偷跑"
    lyrics?.status().status === 'running' && lyrics.cancel();
  });

  // 给自动化验证用的主进程侧句柄（desktop/checkTray.js；t3 也会用）。
  // 托盘菜单是 OS 层控件，Playwright 驱动不了，所以把菜单项会调用的
  // **同一批函数**挂出来——自动化路径与真实用户路径走的是同一份代码。
  // 只挂在主进程全局对象上，渲染进程（sandbox+contextIsolation）够不到。
  globalThis.__qingyinDesktopShell = {
    readState: () => ({
      version: appVersion,
      updateAvailable,
      windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      windowExists: Boolean(mainWindow && !mainWindow.isDestroyed()),
      openAtLogin: settings.openAtLogin,
      trayCreated: Boolean(tray),
      menu: tray ? tray.describe() : [],
      isQuitting,
      // 自启 Run 项会写入的完整命令（验证脚本用它做 node 侧桥接复核，见 README §8）
      loginItemCommand: loginItemCommand(),
    }),
    showMainWindow: () => showMainWindow(),
    hideMainWindow: () => hideMainWindow(),
    toggleMainWindow: () => toggleMainWindow(),
    // 托盘「退出」菜单项的真实处理函数
    quit: () => quitApp(),
    // 托盘「开机自启」菜单项的真实处理函数（含 settings.json 落盘 + 注册表读写；
    // 返回 Promise，验证脚本用 app.evaluate 会自动等它完成）
    setOpenAtLogin: (open) => setOpenAtLogin(open),
    // 只读 OS 侧自启状态（不写）：验证脚本读回用
    readOsOpenAtLogin: () => readOsLoginItem(),
    // ---- t5：补歌词（托盘菜单项同一批函数，E2E 用 app.evaluate 驱动）----
    // 托盘「补歌词…」菜单项的真实处理函数（解析目录 → spawn 工具）
    triggerFillLyrics: () => lyrics?.startFill(),
    // 主进程侧工具状态（runner 真源；渲染进程走 lyrics:status IPC 也能拿到同一份）
    lyricsState: () => lyrics?.status() ?? { status: 'idle' },
    // 托盘「选择补歌词工具…」/「指定音乐文件夹…」的真实处理函数（弹原生对话框并存档）
    chooseLyricsToolScript: () => lyrics?.chooseToolScript(),
    chooseLyricsMusicFolder: () => lyrics?.chooseMusicFolder(),
  };
}
