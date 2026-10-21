'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * t2 验收：托盘 / 关窗到托盘（继续放歌）/ 单实例 / 开机自启 / 版本号。
 *
 * 方法（全部走真实路径，不用"直接改 store 状态"这种捷径）：
 *   0. 用独立的 --user-data-dir 启动（不碰用户真实曲库；单实例锁也按
 *      userData 键控，二启实例必须带同一参数才能撞上同一把锁）
 *   1. 托盘与版本号：readState + 原生窗口标题（BrowserWindow.getTitle）
 *   2. 显示/隐藏：__qingyinDesktopShell.hideMainWindow/showMainWindow + 菜单文案换向
 *   3. 关窗放歌：两条关窗路径都验证——Win32 WM_CLOSE（postCloseToQingyin.ps1，
 *      就是用户点右上角 X 的那条消息路径）与主进程 win.close()；两者都应被
 *      'close' 事件拦截成 hide。等 5 秒，断言：窗口存在但不可见、进程活着、
 *      还在放、进度在走、零控制台报错；期间用 EnumWindows 桌面转储证明屏幕
 *      上真没有窗口。（渲染进程 evaluate window.close() 不能用：那是 CDP 的
 *      强制关闭路径，会绕过 'close' 事件直接销毁 WebContents——实测过。）
 *   4. 二次启动：spawn 同参数第二实例 → 应立即退出（exit 0）且把原实例
 *      窗口唤到前台、不新增窗口
 *   5. 开机自启：setOpenAtLogin(true) → settings.json 写入读回 + 菜单勾选；
 *      注册表写入读回走 node 桥（DSH 沙箱降权 Electron 子进程，app 侧写
 *      不进去是环境限制，命令由 readState 提供、node 侧同模块执行——见
 *      README §8）；最后复位 false（不给这台机器留 Run 项）
 *   6. 托盘「退出」：__qingyinDesktopShell.quit() → 进程 exit 0、端口释放
 *
 * 用法（仓库根目录，先 pnpm build）：
 *   node desktop/checkTray.js
 *
 * 产物：artifacts/desktop/tray-check.json + 过程截图
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');
const { execSync } = require('node:child_process');
const { readLoginItemCommand, enableLoginItem, disableLoginItem } = require('./autoStart.js');

/** execSync 容错版：非零退出码/失败时把输出拼起来返回（值缺失是正常业务态）。 */
function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`;
  }
}

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const ORIGIN = 'http://127.0.0.1:53140';
const userDataDir = path.join(artifactsDir, 'userdata-tray-check');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 桌面快照（全屏截图 + EnumWindows 全量可见顶层窗口转储）。 */
function snapshotDesktop(tag) {
  return new Promise((resolve) => {
    const shotPath = path.join(artifactsDir, `tray-screen-${tag}.png`);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'snapshotDesktop.ps1')],
      { cwd: repoRoot, env: { ...process.env, QY_SHOT_PATH: shotPath }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('close', () => resolve(out.trim()));
    child.on('error', (error) => resolve(String(error)));
  });
}

/**
 * 真实关窗：向主窗口投递 WM_CLOSE（= 用户点右上角 X 的那条路）。
 * 不能用渲染进程 window.close()：CDP 的 window.close() 是 DevTools 的强制关闭
 * 路径，直接销毁 WebContents，绕过主进程的 'close' 事件拦截（实测过）。
 */
function postUserClose() {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'postCloseToQingyin.ps1')],
      { cwd: repoRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, out: out.trim() }));
    child.on('error', (error) => resolve({ code: -1, out: String(error) }));
  });
}

/** 等一个子进程退出（带超时，超时就杀掉并返回 null——不悬挂）。 */
function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(String(error));
    });
  });
}

function isPortOpen(origin) {
  return fetch(origin, { signal: AbortSignal.timeout(3000) })
    .then(() => true)
    .catch(() => false);
}

async function main() {
  const env = { ...process.env };
  // 坑 1：DSH 终端会把 ELECTRON_RUN_AS_NODE 传给子进程，带着它 electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;
  const launchArgs = [desktopDir, '--no-sandbox', `--user-data-dir=${userDataDir}`];

  // 隔离曲库：每次验证从全新 profile 开始（不碰用户的真实 IndexedDB）
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const app = await _electron.launch({
    executablePath: electronPath,
    args: launchArgs,
    cwd: repoRoot,
    env,
    timeout: 60000,
  });
  const pid = app.process().pid;
  const mainLog = [];
  app.process().stdout?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        mainLog.push(line.trimEnd());
        console.log(`    [主进程] ${line.trimEnd()}`);
      }
    }
  });
  app.process().stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        mainLog.push(`[stderr] ${line.trimEnd()}`);
        console.log(`    [主进程-err] ${line.trimEnd()}`);
      }
    }
  });

  const problems = [];
  const facts = { pid, launchArgs };
  const consoleErrors = [];
  /** 断言：立即打印，失败记进 problems（不中断，最后统一汇总）。 */
  function check(condition, label, evidence) {
    const ok = Boolean(condition);
    console.log(`  ${ok ? '✔' : '✖'} ${label}${evidence !== undefined ? ` — ${JSON.stringify(evidence)}` : ''}`);
    if (!ok) problems.push(label);
    return ok;
  }

  console.log(`electron : ${electronPath}`);
  console.log(`pid      : ${pid}`);

  try {
    const win = await app.firstWindow({ timeout: 60000 });
    win.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    win.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await win.waitForLoadState('domcontentloaded');
    await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
    await win.waitForSelector('.app', { timeout: 60000 });

    // 干净 profile：没有曲库 → 导入内置样本（走完整扫描 → IndexedDB → 渲染链路）
    const trackCount = await win.evaluate(() => window.__qingyinTest.loadFixtureLibrary());
    check(trackCount === 4, '内置样本导入（4 首）', { trackCount });
    await win.waitForSelector('.row', { timeout: 60000 });
    await win.screenshot({ path: path.join(artifactsDir, 'tray-check-library.png') });

    // ---------- 1. 托盘与版本号 ----------
    console.log('\n== 1) 托盘与版本号 ==');
    const state0 = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    facts.stateAtBoot = state0;
    check(state0.trayCreated, '托盘已创建（readState.trayCreated）');
    check(state0.version === '0.1.0', '版本号来自根 package.json', { version: state0.version });
    check(state0.updateAvailable === null, '更新提示位本期为 null（不做自动更新）');

    const windowsInfo = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        title: w.getTitle(),
        visible: w.isVisible(),
        destroyed: w.isDestroyed(),
      })),
    );
    facts.windowsAtBoot = windowsInfo;
    const nativeTitle = windowsInfo[0]?.title ?? '';
    check(/轻音播放 v0\.1\.0$/.test(nativeTitle), '原生窗口标题带版本号', { nativeTitle });
    // document.title 不被污染（版本号只在原生标题上，页面标题保持应用自己的行为）
    const pageTitle = await win.title();
    facts.pageTitle = pageTitle;
    check(pageTitle === '轻音播放', '页面标题不被版本号污染', { pageTitle });

    const menuIds = (state0.menu ?? []).filter((m) => m.id).map((m) => m.id);
    // 不再断言"精确全列表"：菜单会被后续任务继续加项（t5 的补歌词三项、t6 的播放三项
    // 都进来过），精确比对每加一项就红一次，而这个脚本不在 `node --test` 范围内，
    // 红了也没人知道（README §6）。改成断言**不变式**，一个都不放松：
    //   ① 必备 id 全集都在；② quit 收尾；③ id 不重复；④ 分隔条不少于原有分组数
    const requiredIds = [
      'toggle-window', // t2：显示/隐藏窗口
      'play-pause', // t6：托盘播放控制
      'prev',
      'next',
      'fill-lyrics', // t5：补歌词
      'lyrics-music-folder',
      'lyrics-tool-settings',
      'open-at-login', // t2：开机自启
      'check-update', // t2：更新提示位（本期禁用）
      'quit', // t2：真退出
    ];
    const missingIds = requiredIds.filter((id) => !menuIds.includes(id));
    check(missingIds.length === 0, '托盘菜单结构完整（必备项一个不缺）', { missingIds, menuIds });
    check(menuIds[menuIds.length - 1] === 'quit', '「退出」是菜单最后一项', { last: menuIds[menuIds.length - 1] });
    check(new Set(menuIds).size === menuIds.length, '菜单项 id 不重复', { menuIds });
    check(
      (state0.menu ?? []).filter((m) => m.type === 'separator').length >= 4,
      '分组分隔条不少于 4 条（窗口/播放/补歌词/自启/更新/退出）',
      { separators: (state0.menu ?? []).filter((m) => m.type === 'separator').length },
    );
    const updateItem = (state0.menu ?? []).find((m) => m.id === 'check-update');
    check(updateItem?.enabled === false, '更新菜单项禁用（预留位）', { updateItem });

    // ---------- 2. 显示/隐藏切换 ----------
    console.log('\n== 2) 显示/隐藏切换 ==');
    await app.evaluate(() => globalThis.__qingyinDesktopShell.hideMainWindow());
    const hiddenState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    check(hiddenState.windowVisible === false && hiddenState.windowExists === true, '隐藏后窗口不可见但存在');
    const hiddenLabel = (hiddenState.menu ?? []).find((m) => m.id === 'toggle-window')?.label;
    check(hiddenLabel === '显示窗口', '菜单文案换向（隐藏时 → 显示窗口）', { hiddenLabel });

    await app.evaluate(() => globalThis.__qingyinDesktopShell.showMainWindow());
    const shownState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    check(shownState.windowVisible === true, '重新显示');
    const shownLabel = (shownState.menu ?? []).find((m) => m.id === 'toggle-window')?.label;
    check(shownLabel === '隐藏窗口', '菜单文案换向（可见时 → 隐藏窗口）', { shownLabel });

    // ---------- 3. 关窗 → 托盘：音乐继续放 ----------
    console.log('\n== 3) 关窗到托盘（音乐不能停） ==');
    // 样本只有 2 秒/首：切成列表循环，否则整队 8 秒就放完停下，
    // "5 秒后还在放"就永远验不过（mode 经 cycleMode 轮换到 repeat-all）
    const mode = await win.evaluate(() => {
      const test = window.__qingyinTest;
      for (let i = 0; i < 4; i++) {
        if (test.state().mode === 'repeat-all') return test.state().mode;
        test.cycleMode();
      }
      return test.state().mode;
    });
    facts.playbackMode = mode;
    check(mode === 'repeat-all', '播放模式 = 列表循环（长测不被 8 秒队列卡死）', { mode });
    // 真实双击列表第一行开始播放（CDP 输入 = 用户手势，不是 evaluate 凭空 togglePlay）
    await win.locator('.row').first().dblclick({ timeout: 15000 });
    await win.waitForFunction(
      () => !window.__qingyinTest.paused() && window.__qingyinTest.positionSec() > 0.05,
      null,
      { timeout: 20000 },
    );
    const before = await win.evaluate(() => ({
      paused: window.__qingyinTest.paused(),
      positionSec: window.__qingyinTest.positionSec(),
      currentIndex: window.__qingyinTest.state().currentIndex,
      playing: window.__qingyinTest.state().playing,
      audioSrc: window.__qingyinTest.audioSrc(),
    }));
    facts.playingBeforeClose = before;
    check(before.paused === false && before.playing === true, '关窗前：正在播放', {
      positionSec: before.positionSec,
      currentIndex: before.currentIndex,
    });

    // 关窗路径 A：Win32 WM_CLOSE（= 用户点右上角 X 的那条消息路径）
    const closeA = await postUserClose();
    facts.userCloseAWm = closeA;
    check(closeA.code === 0, '向主窗口投递 WM_CLOSE（X 按钮路径）', { result: closeA.out });
    // close 事件被拦截成 hide 需要一小会儿
    let closedState = null;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      closedState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
      if (!closedState.windowVisible) break;
    }
    facts.stateAfterClose = closedState;
    check(closedState.windowVisible === false, '关窗后：窗口不可见');
    check(closedState.windowExists === true, '关窗后：窗口对象还在（被拦截成 hide，不是销毁）');
    check(closedState.isQuitting === false, '关窗不触发退出流程');

    // 桌面证据：屏幕上真的没有轻音播放窗口了（进程还活着）。
    // 只匹配 WINDOW: 开头的转储行——SHOT: 行的路径里也含「轻音播放」目录名，会误报。
    const desktopDump = await snapshotDesktop('after-close');
    facts.desktopAfterClose = desktopDump;
    const qyWindows = desktopDump
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('WINDOW:') && line.includes('轻音播放'));
    check(qyWindows.length === 0, '桌面顶层窗口里没有轻音播放', {
      qyWindows: qyWindows.join(' ; ') || '(无)',
    });

    // 进程活着 + 静态服务还活着
    check(app.process().exitCode === null && !app.process().killed, '关窗后进程仍存活');
    check(await isPortOpen(ORIGIN), '关窗后本地静态服务仍响应');

    // 关窗路径 B：主进程 win.close()（API 路径，同样应被拦截成 hide）
    await app.evaluate(() => globalThis.__qingyinDesktopShell.showMainWindow());
    const closeB = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.close();
    });
    void closeB;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      closedState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
      if (!closedState.windowVisible) break;
    }
    facts.stateAfterCloseB = closedState;
    check(closedState.windowVisible === false && closedState.windowExists === true, '主进程 win.close() 同样被拦截成 hide');

    // 等 5 秒：音乐必须还在放（进度在走，2 秒样本会自动切到下一首）
    await sleep(5000);
    const after = await win.evaluate(() => ({
      paused: window.__qingyinTest.paused(),
      positionSec: window.__qingyinTest.positionSec(),
      currentIndex: window.__qingyinTest.state().currentIndex,
      playing: window.__qingyinTest.state().playing,
    }));
    facts.playingAfter5sHidden = after;
    check(after.paused === false && after.playing === true, '关窗 5 秒后：仍在播放');
    check(
      after.positionSec > 0.05 || after.currentIndex > before.currentIndex,
      '进度在走（同曲前进或已自动切歌）',
      { before: { positionSec: before.positionSec, currentIndex: before.currentIndex }, after },
    );
    check(consoleErrors.length === 0, '全程零渲染进程报错', {
      errors: consoleErrors.slice(0, 5),
    });

    // ---------- 4. 二次启动：唤前台，不开新窗 ----------
    console.log('\n== 4) 二次启动（单实例） ==');
    const secondEnv = { ...env };
    const second = spawn(electronPath, launchArgs, { cwd: repoRoot, env: secondEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let secondOut = '';
    second.stdout.on('data', (c) => (secondOut += c.toString()));
    second.stderr.on('data', (c) => (secondOut += c.toString()));
    const secondExit = await waitExit(second, 30000);
    facts.secondInstance = { exit: secondExit, output: secondOut.trim().slice(0, 2000) };
    check(secondExit === 0, '第二个实例立即退出（exit 0）', { secondExit });

    await sleep(1000);
    const afterSecondState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    const windowsAfterSecond = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), focused: w.isFocused() })),
    );
    facts.afterSecondInstance = { state: afterSecondState, windows: windowsAfterSecond };
    check(afterSecondState.windowVisible === true, '二启把原窗口唤到可见');
    check(windowsAfterSecond.length === 1, '没有出现第二个窗口', { count: windowsAfterSecond.length });
    check(app.process().exitCode === null && !app.process().killed, '原实例进程仍存活');
    facts.secondWindowFocused = windowsAfterSecond[0]?.focused === true;
    console.log(`  · 焦点状态（证据，不硬断言）: focused=${windowsAfterSecond[0]?.focused}`);

    // 关窗状态下二启：应该把窗口拉回来（用户"找不到窗口"的恢复路径）
    await app.evaluate(() => globalThis.__qingyinDesktopShell.hideMainWindow());
    const third = spawn(electronPath, launchArgs, { cwd: repoRoot, env: secondEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const thirdExit = await waitExit(third, 30000);
    await sleep(800);
    const afterThirdState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    facts.hiddenThenRelaunch = { thirdExit, visible: afterThirdState.windowVisible };
    check(thirdExit === 0 && afterThirdState.windowVisible === true, '隐藏状态下二启 → 窗口被唤回', {
      thirdExit,
      visible: afterThirdState.windowVisible,
    });

    // ---------- 5. 开机自启开关 ----------
    console.log('\n== 5) 开机自启（写 + 读回） ==');
    // 5a) app 侧开关：settings.json 写入 + 菜单勾选 + OS 尽力同步
    const onResult = await app.evaluate(() => globalThis.__qingyinDesktopShell.setOpenAtLogin(true));
    facts.autostartOn = onResult;
    check(onResult.settings.openAtLogin === true, '设置状态 = true（写入）');
    const settingsFileText = fs.readFileSync(onResult.settingsFile, 'utf8');
    const settingsJson = JSON.parse(settingsFileText);
    check(settingsJson.openAtLogin === true, 'settings.json 落盘可读回 = true', { settingsJson });
    const stateOn = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    const menuOn = (stateOn.menu ?? []).find((m) => m.id === 'open-at-login');
    check(menuOn?.checked === true, '托盘菜单勾选 = true');

    // 5b) 注册表写入与读回：DSH 沙箱会降权 Electron 的子进程（reg 写入"拒绝访问"，
    // 见 README §8），app 侧写不进去是环境限制；用 readState 报出的同一份命令在
    // node 侧桥接执行——生产环境（用户双击）里没有这层限制，走的就是 app 自己的写入。
    const intendedCommand = stateOn.loginItemCommand;
    const bridgeEnable = await enableLoginItem({
      exePath: electronPath,
      args: [desktopDir, '--no-sandbox'],
      name: 'qingyin-player',
    });
    facts.bridgeEnable = bridgeEnable;
    check(bridgeEnable.ok && bridgeEnable.approved, 'Run + StartupApproved 写入成功（node 桥）');
    check(bridgeEnable.command === intendedCommand, '桥接命令与 app 计算的命令一致', {
      bridge: bridgeEnable.command,
      app: intendedCommand,
    });
    const regReadBack = await readLoginItemCommand({ name: 'qingyin-player' });
    facts.regReadBack = regReadBack;
    check(regReadBack === intendedCommand, '注册表读回命令一致（reg export 精确比对）');

    // 5c) 独立证据（Node 侧，不经 app 与桥）：直接 reg query
    const regQueryRes = safeExec(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v qingyin-player',
    );
    facts.regRunValueOn = regQueryRes.trim();
    check(regQueryRes.includes('REG_SZ'), 'reg query 独立确认 Run 值存在（qingyin-player）');
    const approvedRes = safeExec(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" /v qingyin-player',
    );
    check(approvedRes.includes('REG_BINARY'), 'StartupApproved 已写（任务管理器里显示为启用）');

    // 5d) app 侧 OS 读回：注册表有值后，app 的存在性读法应感知到
    const osRead = await app.evaluate(() => globalThis.__qingyinDesktopShell.readOsOpenAtLogin());
    facts.appOsRead = osRead;
    check(osRead.openAtLogin === true, 'app 侧 OS 读回感知到 Run 项（存在性模式）', { readMode: osRead.readMode });

    // 5e) 复位（不给这台机器留 Run 项）：app 开关关 + node 桥删除注册表
    const offResult = await app.evaluate(() => globalThis.__qingyinDesktopShell.setOpenAtLogin(false));
    facts.autostartOff = offResult;
    check(offResult.settings.openAtLogin === false, '复位：设置状态 = false（写入）');
    const offJson = JSON.parse(fs.readFileSync(offResult.settingsFile, 'utf8'));
    check(offJson.openAtLogin === false, '复位：settings.json 落盘 = false');
    const stateOff = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    const menuOff = (stateOff.menu ?? []).find((m) => m.id === 'open-at-login');
    check(menuOff?.checked === false, '复位：托盘菜单勾选 = false');
    await disableLoginItem({ name: 'qingyin-player' });
    const regOff = await readLoginItemCommand({ name: 'qingyin-player' });
    check(regOff === null, '复位：Run 项已删除（读回为空）', { regOff });

    // ---------- 6. 托盘「退出」= 真退出 ----------
    console.log('\n== 6) 托盘退出 ==');
    const quitExit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 20000);
      app.process().on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      app.evaluate(() => globalThis.__qingyinDesktopShell.quit());
    });
    facts.quitExit = quitExit;
    check(quitExit === 0, '托盘「退出」→ 进程 exit 0', { quitExit });

    // 端口应随之释放（静态服务在 will-quit 里关闭）
    let portClosed = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      if (!(await isPortOpen(ORIGIN))) {
        portClosed = true;
        break;
      }
    }
    check(portClosed, '退出后端口已释放（服务已关）');
  } finally {
    // 汇总
    const report = {
      ok: problems.length === 0,
      problems,
      facts,
      mainLog: mainLog.slice(0, 120),
      consoleErrors,
    };
    fs.writeFileSync(path.join(artifactsDir, 'tray-check.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log('\n== 汇总 ==');
    if (problems.length === 0) {
      console.log('✔ t2 五件套全部通过（托盘/关窗放歌/单实例/自启/版本号）');
      console.log(`报告: artifacts/desktop/tray-check.json`);
    } else {
      console.log(`✖ 失败 ${problems.length} 项:`);
      for (const problem of problems) console.log(`  - ${problem}`);
      console.log(`报告: artifacts/desktop/tray-check.json`);
    }
    try {
      await app.close();
    } catch {
      // 进程已经自己退出（第 6 步）时会抛——预期内
    }
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error('checkTray 崩了：');
  console.error(error);
  process.exitCode = 1;
});
