'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, screen } = require('electron');
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
// t6：托盘播放控制（状态规范化 + 命令白名单）与窗口状态记忆（几何决策 + 防抖写盘）
const { PLAYBACK_STATUS_UNKNOWN, isShellCommandType, normalizePlaybackStatus } = require('./playbackStatus.js');
const { captureWindowState, createDebouncedSaver, resolveStartupWindow } = require('./windowState.js');
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
// t6：播放状态。**只有渲染进程知道它在放什么**，主进程存的是它上报的规范化结果，
// 托盘菜单的「播放/暂停」文案与禁用态都读这里——绝不从别处推断（猜出来的文案会骗用户）
let playback = { ...PLAYBACK_STATUS_UNKNOWN };
// t6：启动时的窗口几何决策（source/reason 要给验证脚本看，回退必须能自证）
let startupWindow = null;
// t6：几何写盘的防抖器（拖动过程中不写，停下来写一次；真退出时 flush）
let windowSaver = null;

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

// ---- t6：窗口状态记忆 ----

/** 部分更新地写 settings.json（只传要改的键，别人的键不受影响）。 */
function persistSettings(patch) {
  settings = saveSettings(userDataDir, patch);
  return settings;
}

/**
 * 立刻抓一次几何并落盘（绕过防抖）。
 *
 * 用在真退出路径上：进程马上就要没了，防抖的定时器不会有机会跑。
 * 抓不到（窗口已销毁/最小化）时返回 null，不会把垃圾坐标写进存档。
 *
 * @returns {{ captured: object | null, wrote: boolean, saved: object | null }}
 */
function saveWindowStateNow() {
  const captured = captureWindowState(mainWindow);
  if (captured) windowSaver?.schedule(captured);
  const wrote = windowSaver ? windowSaver.flush() : false;
  return { captured, wrote, saved: settings.windowState };
}

/** 几何变化时排一次写盘（防抖 + 去重在 windowState.js 里）。 */
function scheduleWindowStateSave(win) {
  windowSaver?.schedule(captureWindowState(win));
}

// ---- t6：托盘播放控制 ----

/**
 * 把一条播放命令送给渲染进程。
 *
 * 用的是 `webContents.send`——窗口**隐藏但没销毁**时照样送达，这正是本功能的
 * 意义所在：关窗到托盘之后音乐还在放，托盘上的暂停/切歌也就必须还能用。
 *
 * @param {string} type 'play-pause' | 'prev' | 'next'（白名单见 constants.js）
 * @returns {{ ok: boolean, type?: string, windowVisible?: boolean, reason?: string }}
 */
function sendPlaybackCommand(type) {
  if (!isShellCommandType(type)) {
    return { ok: false, reason: `不是合法的播放命令：${String(type)}` };
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, reason: '主窗口不存在（渲染进程已销毁），命令无处可送' };
  }
  mainWindow.webContents.send(constants.IPC_SHELL_COMMAND, { type });
  return { ok: true, type, windowVisible: mainWindow.isVisible() };
}

/** 渲染进程上报播放状态 → 规范化存下 → 刷新托盘菜单文案。 */
function applyPlaybackStatus(raw) {
  playback = normalizePlaybackStatus(raw);
  tray?.refresh();
  return playback;
}

function createWindow() {
  const win = createMainWindow({
    distDir,
    title: windowTitle(),
    // 几何来自 boot() 里的 resolveStartupWindow（已用 screen.getAllDisplays() 校验过，
    // 越界的存档在那一步就被换成主屏居中了）。null = 交给系统定位
    x: startupWindow?.bounds?.x ?? null,
    y: startupWindow?.bounds?.y ?? null,
    width: startupWindow?.bounds?.width,
    height: startupWindow?.bounds?.height,
  });
  mainWindow = win;

  // 关窗到托盘：**只隐藏，绝不销毁**（销毁 = 渲染进程死 = 音乐停）
  win.on('close', (event) => {
    if (isQuitting) {
      // 真退出（托盘「退出」/系统会话结束）：把最后的几何落盘再放行
      saveWindowStateNow();
      return;
    }
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

  // t6：几何变化 → 防抖写盘。resize/move 在拖动过程中每次像素变动都触发，
  // 所以既不能每次都写（见 windowState.js 的防抖），也不能只靠退出时写一次
  // （进程被杀就全丢了）。最小化时 captureWindowState 返回 null，
  // 不会把 Windows 那个 -32000 的假坐标存进档。
  for (const eventName of ['resize', 'move', 'maximize', 'unmaximize', 'restore']) {
    win.on(eventName, () => scheduleWindowStateSave(win));
  }
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
  showTrayHintOnce();
}

/**
 * 第一次把窗口收进托盘时提示一次。
 *
 * Windows 11 默认把新托盘图标收进 ^ 溢出区，用户反馈"托盘根本没有图标"——
 * 这不是 bug，是系统行为，且系统没给应用"自己固定"的 API。所以用一次气泡
 * 指路（设置 → 任务栏 → 其他系统托盘图标），写进 settings 后不再重复。
 * 气泡弹不出来（被专注助手拦、非 Windows）就不落标记，下次还有机会。
 */
function showTrayHintOnce() {
  if (settings.trayHintShown) return;
  const shown = tray?.showBalloon?.({
    title: '轻音播放仍在运行',
    content:
      '窗口已收进托盘，音乐继续播放。Windows 11 默认把新图标收在任务栏的 ^ 里，' +
      '可在「设置 → 任务栏 → 其他系统托盘图标」把它打开。真退出请用托盘菜单的「退出」。',
  });
  if (shown) {
    settings = saveSettings(userDataDir, { trayHintShown: true });
  }
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
    // t6：播放状态（渲染进程上报后规范化的结果）——菜单文案与禁用态都读它
    getPlayback: () => playback,
    onToggleWindow: () => toggleMainWindow(),
    onShowWindow: () => showMainWindow(),
    // t6：托盘「播放/暂停」「上一首」「下一首」三个菜单项共用这一条发送路径
    onPlaybackCommand: (type) => {
      const result = sendPlaybackCommand(type);
      if (!result.ok) console.log(`[desktop] 托盘播放命令未送达：${result.reason}`);
    },
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
    // t6：渲染进程上报播放状态（shell:status）→ 存下并刷新托盘菜单文案
    onShellStatus: (raw) => applyPlaybackStatus(raw),
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

  // t6：决定这次启动用哪个窗口几何。
  // 存档必须先过 `screen.getAllDisplays()` 校验：多显示器用户拔掉副屏之后，
  // 上次的坐标会落在一块已经不存在的屏幕上，窗口"打开了但看不见"。
  // 越界就回退主屏居中默认尺寸，并把原因打进日志（验证脚本读 source/reason 自证）。
  startupWindow = resolveStartupWindow({
    saved: settings.windowState,
    displays: screen.getAllDisplays(),
    primaryDisplay: screen.getPrimaryDisplay(),
  });
  windowSaver = createDebouncedSaver({
    save: (state) => {
      try {
        persistSettings({ windowState: state });
      } catch (error) {
        // 写盘失败不该影响播放/窗口（下次几何变化会再试）
        console.error('[desktop] 窗口状态写盘失败：', error);
      }
    },
  });
  console.log(
    `[desktop] 窗口几何来源 = ${startupWindow.source}（${startupWindow.reason}）` +
      `${startupWindow.maximized ? '，存档要求最大化' : ''}`,
  );

  createWindow();
  // 存档说要最大化就在显示之前最大化，避免用户看到一次"从小变大"的跳动
  if (startupWindow.maximized) mainWindow.maximize();
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
    // t6：兜底再落一次盘。正常路径是窗口 'close' 事件里存（那时窗口还活着，
    // 能抓到真实几何）；走到这里如果还有防抖中的待写内容，就把它写掉。
    saveWindowStateNow();
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
    // ---- t6：托盘播放控制 + 窗口状态记忆（同样挂"菜单项调用的那批函数"）----
    // 托盘「播放/暂停」「上一首」「下一首」三个菜单项的真实处理函数
    playbackCommand: (type) => sendPlaybackCommand(type),
    // 主进程侧记着的播放状态（渲染进程上报 → playbackStatus.js 规范化的结果）
    readPlaybackStatus: () => ({ ...playback }),
    // 本次启动的窗口几何决策：存档 / 实际采用 / 来源 / 原因 / 写盘计数
    readWindowState: () => ({
      saved: settings.windowState,
      resolved: startupWindow ? startupWindow.bounds : null,
      source: startupWindow ? startupWindow.source : null,
      reason: startupWindow ? startupWindow.reason : null,
      maximized: startupWindow ? startupWindow.maximized === true : false,
      current: captureWindowState(mainWindow),
      saveStats: windowSaver ? windowSaver.stats() : null,
    }),
    // 绕过防抖立刻落盘（验证脚本用；真退出路径走的也是这个函数）
    saveWindowStateNow: () => saveWindowStateNow(),
  };
}
