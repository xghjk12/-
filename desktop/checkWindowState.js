'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * t6 验收之二：窗口状态记忆（位置/尺寸/最大化）+ **屏幕外回退**。
 *
 * 四次真实启动，全部用同一个隔离 profile（--user-data-dir），settings.json
 * 由 node 侧直接读，不用"问主进程它以为存了什么"这种自证：
 *
 *   启动 1（首次，无存档）
 *     - 启动几何来源应是 default（主屏居中 + 默认尺寸）
 *     - setBounds 到一个特定几何 → 等防抖窗口过去 → 断言 settings.json 里
 *       windowState 就是那个几何（证明是**真的写盘了**，不是内存里的值）
 *     - maximize → 断言存档 maximized=true，且宽高是 getNormalBounds 的值
 *       （不是整块屏幕的尺寸——存错了用户还原窗口会得到一个巨大的窗口）
 *     - 托盘「退出」（真退出，不是 hide）→ 断言存档没丢
 *   启动 2（有存档：最大化 + 特定几何）
 *     - 窗口应直接是最大化状态，来源是 saved
 *     - 还原后几何应回到存档里的普通几何
 *     - 改到新几何 → 退出 → 存档应更新为新几何
 *   启动 3（存档被写成屏幕外坐标 -32000,-32000）
 *     - 窗口必须**可见且在屏幕内**（用 windowState.js 的同一套判定，不是肉眼）
 *     - 来源必须是 default，reason 里要写清"不在任何屏幕"
 *   启动 4（存档被写成拔掉的副屏坐标 x=3000）
 *     - 同上：回退到主屏居中；然后隐藏窗口再退出，存档不能变成垃圾坐标
 *
 * 用法（仓库根目录，先 pnpm build）：
 *   node desktop/checkWindowState.js
 *
 * 产物：artifacts/desktop/window-state-check.json
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');
const { isOnDisplays, MIN_VISIBLE_PX } = require('./windowState.js');
const { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } = require('./constants.js');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const userDataDir = path.join(artifactsDir, 'userdata-window-state-check');
const settingsFile = path.join(userDataDir, 'settings.json');

const problems = [];
const facts = {};
const mainLog = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(condition, label, evidence) {
  const ok = Boolean(condition);
  console.log(`  ${ok ? '✔' : '✖'} ${label}${evidence !== undefined ? ` — ${JSON.stringify(evidence)}` : ''}`);
  if (!ok) problems.push(label);
  return ok;
}

/** 直接读磁盘上的 settings.json（自证不如读文件）。 */
function readSettingsFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function writeWindowState(state) {
  const current = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, `${JSON.stringify({ ...current, windowState: state }, null, 2)}\n`, 'utf8');
}

/** 几何比对：Windows 的边框/阴影可能让读数差几个像素，给一点容差。 */
function closeEnough(actual, expected, tolerance = 8) {
  if (!actual) return false;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Math.abs((actual[key] ?? NaN) - expected[key]) > tolerance) return false;
  }
  return true;
}

async function launchOnce(tag) {
  const env = { ...process.env };
  // 坑 1：DSH 终端会把 ELECTRON_RUN_AS_NODE 传给子进程，带着它 electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;
  const launchArgs = [desktopDir, '--no-sandbox', `--user-data-dir=${userDataDir}`];
  const app = await _electron.launch({
    executablePath: electronPath,
    args: launchArgs,
    cwd: repoRoot,
    env,
    timeout: 60000,
  });
  app.process().stdout?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) mainLog.push(`[${tag}] ${line.trimEnd()}`);
    }
  });
  app.process().stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) mainLog.push(`[${tag}:err] ${line.trimEnd()}`);
    }
  });
  const win = await app.firstWindow({ timeout: 60000 });
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

/**
 * 启动（带重试）。
 *
 * 这台机器上连续多次启动 Electron 时，Playwright 的 CDP 连接偶尔会在应用已经
 * 正常起来之后被重置（`WebSocket error: read ECONNRESET`，主进程日志显示 origin
 * 与窗口几何都打印出来了，说明**不是产品问题**，是调试通道抖动）。
 * 一个脚本要连开四次进程，撞上的概率不低，所以重试两次——但每次失败都记进
 * 报告的 mainLog，不装作没发生。
 */
async function launch(tag) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await launchOnce(tag);
    } catch (error) {
      lastError = error;
      const firstLine = String(error?.message ?? error).split('\n')[0];
      mainLog.push(`[${tag}] 第 ${attempt} 次启动失败：${firstLine}`);
      console.log(`  ! ${tag} 第 ${attempt} 次启动失败（${firstLine}），2 秒后重试`);
      await sleep(2000);
    }
  }
  throw lastError;
}

/** 走托盘「退出」那条真退出路径（会触发退出前落盘）。 */
async function quit(app) {
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 20000);
    app.process().on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    app.evaluate(() => globalThis.__qingyinDesktopShell.quit()).catch(() => resolve('evaluate-failed'));
  });
  try {
    await app.close();
  } catch {
    // 进程已经自己退出时会抛——预期内
  }
  return code;
}

/** 主窗口几何 + 显示器工作区（都从主进程读，node 侧只判定）。 */
async function readGeometry(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      bounds: win.getBounds(),
      normalBounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      minimized: win.isMinimized(),
      visible: win.isVisible(),
      displays: screen.getAllDisplays().map((display) => ({ workArea: display.workArea, bounds: display.bounds })),
    };
  });
}

async function main() {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  console.log(`electron : ${electronPath}`);
  console.log(`profile  : ${userDataDir}`);

  // ================= 启动 1：首次启动 → 存几何 → 最大化 → 退出 =================
  console.log('\n== 启动 1：首次启动、记住几何、最大化 ==');
  {
    const { app, win } = await launch('run1');
    const startup = await app.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
    facts.run1Startup = startup;
    check(startup.saved === null, '首次启动没有存档（settings.json 里 windowState=null）', { saved: startup.saved });
    check(startup.source === 'default', '首次启动的几何来源是 default', { source: startup.source });

    const geometry0 = await readGeometry(app);
    facts.run1Displays = geometry0.displays;
    check(geometry0.visible && !geometry0.maximized, '窗口可见且未最大化');
    check(
      isOnDisplays(geometry0.bounds, geometry0.displays, MIN_VISIBLE_PX),
      '首次启动的窗口在屏幕内',
      geometry0.bounds,
    );

    // 目标几何：在主屏工作区内、且明显不同于默认尺寸（这样"恢复了"才可证伪）
    const primary = geometry0.displays.find((display) => display.workArea.x === 0 && display.workArea.y === 0) ?? geometry0.displays[0];
    const target = {
      x: primary.workArea.x + 60,
      y: primary.workArea.y + 40,
      // 请求尺寸不能小于窗口的 minWidth/minHeight，否则 Electron 会夹一次，
      // "存进去的和我请求的不一样"就成了假失败
      width: Math.max(WINDOW_MIN_WIDTH, Math.min(1180, primary.workArea.width - 120)),
      height: Math.max(WINDOW_MIN_HEIGHT, Math.min(760, primary.workArea.height - 120)),
    };
    facts.run1Target = target;
    await app.evaluate(
      ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
      target,
    );
    await sleep(1500); // 防抖 600ms + 余量

    const onDisk1 = readSettingsFromDisk();
    facts.run1SettingsAfterResize = onDisk1;
    check(
      closeEnough(onDisk1.windowState, target),
      'resize/move 之后 settings.json 里真的写下了这个几何',
      { saved: onDisk1.windowState, target },
    );

    // 防抖要生效：连续小步拖动不该每步都写盘（用主进程计数器证明）
    const writesBefore = await app.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState().saveStats.writes);
    for (let step = 0; step < 12; step += 1) {
      await app.evaluate(({ BrowserWindow }, index) => {
        const current = BrowserWindow.getAllWindows()[0].getBounds();
        BrowserWindow.getAllWindows()[0].setBounds({ ...current, x: current.x + 1, y: current.y + 1 });
      }, step);
      await sleep(40);
    }
    const writesDuringDrag = await app.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState().saveStats.writes);
    facts.run1Writes = { writesBefore, writesDuringDrag };
    check(
      writesDuringDrag - writesBefore <= 2,
      '连续 12 次像素级移动只触发 ≤2 次写盘（防抖生效，不是每次像素变动都写）',
      facts.run1Writes,
    );

    // 最大化：存档要记 maximized=true，且宽高是"还原后的普通几何"
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await sleep(1500);
    const onDisk2 = readSettingsFromDisk();
    facts.run1SettingsAfterMaximize = onDisk2;
    check(onDisk2.windowState?.maximized === true, '最大化后存档 maximized=true', onDisk2.windowState);
    const maximizedBounds = await readGeometry(app);
    check(
      onDisk2.windowState?.width !== maximizedBounds.bounds.width ||
        onDisk2.windowState?.height !== maximizedBounds.bounds.height,
      '存档里存的是 getNormalBounds（不是整块屏幕的尺寸）',
      { saved: onDisk2.windowState, screenBounds: maximizedBounds.bounds },
    );
    // 最大化/还原一来一回，Windows 会让"普通几何"漂十几个像素（不可见边框 + DPI 缩放），
    // 所以这条用宽容差；真正要钉住的是上面那条：存的不是整块屏幕的尺寸。
    check(
      closeEnough(
        onDisk2.windowState,
        { x: target.x + 12, y: target.y + 12, width: target.width, height: target.height },
        40,
      ),
      '普通几何仍然是拖动之后的那个位置（容差 40px：Windows 边框/DPI 会漂）',
      { saved: onDisk2.windowState, expected: target },
    );

    const exitCode = await quit(app);
    facts.run1QuitExit = exitCode;
    check(exitCode === 0, '托盘「退出」→ exit 0', { exitCode });
    const onDisk3 = readSettingsFromDisk();
    facts.run1SettingsAfterQuit = onDisk3;
    check(onDisk3.windowState?.maximized === true, '真退出时窗口状态仍在（没被 hide 路径冲掉）', onDisk3.windowState);
    await sleep(500);
    void win;
  }

  // ================= 启动 2：恢复最大化 + 普通几何 =================
  console.log('\n== 启动 2：恢复上次的位置/尺寸/最大化 ==');
  {
    const { app } = await launch('run2');
    const startup = await app.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
    facts.run2Startup = startup;
    check(startup.source === 'saved', '几何来源是 saved（沿用上次的存档）', { source: startup.source, reason: startup.reason });
    check(startup.maximized === true, '存档说要最大化 → 启动时最大化', startup.resolved);

    await sleep(1200);
    const geometry = await readGeometry(app);
    facts.run2Geometry = geometry;
    check(geometry.maximized === true, '窗口真的是最大化状态（BrowserWindow.isMaximized）');
    check(geometry.visible === true, '窗口可见');

    const expectedNormal = facts.run1SettingsAfterQuit.windowState;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await sleep(800);
    const restored = await readGeometry(app);
    facts.run2Restored = restored;
    check(
      closeEnough(restored.bounds, expectedNormal),
      '还原之后回到存档里的普通几何（位置与尺寸都对）',
      { restored: restored.bounds, expectedNormal },
    );

    // 换个几何再退出，证明"每次都记最新的"
    const primary = geometry.displays[0];
    const next = {
      x: primary.workArea.x + 220,
      y: primary.workArea.y + 160,
      width: Math.max(WINDOW_MIN_WIDTH, Math.min(1024, primary.workArea.width - 240)),
      height: Math.max(WINDOW_MIN_HEIGHT, Math.min(700, primary.workArea.height - 240)),
    };
    facts.run2Target = next;
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), next);
    await sleep(1500);
    const onDisk = readSettingsFromDisk();
    facts.run2Settings = onDisk;
    check(closeEnough(onDisk.windowState, next), '新几何写进了 settings.json', { saved: onDisk.windowState, next });
    check(onDisk.windowState?.maximized === false, '还原后存档 maximized=false', onDisk.windowState);

    const exitCode = await quit(app);
    facts.run2QuitExit = exitCode;
    check(exitCode === 0, 'exit 0', { exitCode });
    await sleep(500);
  }

  // ================= 启动 3：存档是 -32000（最小化时那种垃圾坐标） =================
  console.log('\n== 启动 3：存档坐标在屏幕外（-32000）→ 必须回退到屏幕内 ==');
  {
    writeWindowState({ x: -32000, y: -32000, width: 1200, height: 800, maximized: false });
    check(readSettingsFromDisk().windowState?.x === -32000, '存档已被写成屏幕外坐标（前置条件）');

    const { app } = await launch('run3');
    const startup = await app.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
    facts.run3Startup = startup;
    check(startup.source === 'default', '来源回退成 default', { source: startup.source });
    check(/不在任何屏幕/.test(startup.reason ?? ''), 'reason 说明了为什么回退', { reason: startup.reason });

    await sleep(1000);
    const geometry = await readGeometry(app);
    facts.run3Geometry = geometry;
    check(geometry.visible === true, '窗口可见（不是"打开了但看不见"）');
    check(
      isOnDisplays(geometry.bounds, geometry.displays, MIN_VISIBLE_PX),
      '窗口几何落在某块屏幕的工作区里',
      geometry.bounds,
    );
    check(
      geometry.bounds.x > -1000 && geometry.bounds.y > -1000,
      '坐标不是 -32000 那种垃圾值',
      { x: geometry.bounds.x, y: geometry.bounds.y },
    );

    const exitCode = await quit(app);
    facts.run3QuitExit = exitCode;
    check(exitCode === 0, 'exit 0', { exitCode });
    const onDisk = readSettingsFromDisk();
    facts.run3SettingsAfterQuit = onDisk;
    check(
      isOnDisplays(onDisk.windowState, geometry.displays, MIN_VISIBLE_PX),
      '退出时写回的是屏幕内的几何（下次启动不会再回退）',
      onDisk.windowState,
    );
    await sleep(500);
  }

  // ================= 启动 4：拔掉的副屏坐标 + 隐藏后退出 =================
  console.log('\n== 启动 4：存档在"被拔掉的副屏"上 → 回退；隐藏后退出不能存进垃圾坐标 ==');
  {
    writeWindowState({ x: 3000, y: 200, width: 1200, height: 800, maximized: false });
    const { app } = await launch('run4');
    const startup = await app.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
    facts.run4Startup = startup;

    const geometry = await readGeometry(app);
    facts.run4Geometry = geometry;
    const onlyPrimary = geometry.displays.length === 1;
    facts.run4DisplayCount = geometry.displays.length;
    if (onlyPrimary) {
      check(startup.source === 'default', '副屏不存在 → 来源回退成 default', { source: startup.source });
      check(
        isOnDisplays(geometry.bounds, geometry.displays, MIN_VISIBLE_PX),
        '窗口在屏幕内',
        geometry.bounds,
      );
    } else {
      // 这台机器真的接了副屏且 3000,200 落在它上面 → 沿用才对
      check(startup.source === 'saved', '这台机器有副屏且坐标有效 → 沿用存档', { source: startup.source });
      check(
        isOnDisplays(geometry.bounds, geometry.displays, MIN_VISIBLE_PX),
        '窗口在屏幕内（副屏上）',
        geometry.bounds,
      );
    }

    // 隐藏窗口（关窗到托盘）再真退出：存档必须是真实几何，不能是隐藏/最小化产生的垃圾
    await app.evaluate(() => globalThis.__qingyinDesktopShell.hideMainWindow());
    await sleep(800);
    const hiddenState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    check(hiddenState.windowVisible === false && hiddenState.windowExists === true, '窗口已隐藏但未销毁');
    const exitCode = await quit(app);
    facts.run4QuitExit = exitCode;
    check(exitCode === 0, '隐藏状态下走托盘「退出」→ exit 0', { exitCode });

    const onDisk = readSettingsFromDisk();
    facts.run4SettingsAfterQuit = onDisk;
    check(
      onDisk.windowState && onDisk.windowState.x > -1000 && onDisk.windowState.y > -1000,
      '隐藏 + 退出之后存档里没有 -32000 这类垃圾坐标',
      onDisk.windowState,
    );
    check(
      isOnDisplays(onDisk.windowState, geometry.displays, MIN_VISIBLE_PX),
      '存档几何仍在屏幕内（下次启动可直接沿用）',
      onDisk.windowState,
    );
    await sleep(500);
  }

  // ================= 汇总 =================
  const report = { ok: problems.length === 0, problems, facts, mainLog: mainLog.slice(0, 160) };
  fs.writeFileSync(
    path.join(artifactsDir, 'window-state-check.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log('\n== 汇总 ==');
  if (problems.length === 0) {
    console.log('✔ 窗口状态记忆全部通过（记住/恢复/最大化/屏幕外回退）');
  } else {
    console.log(`✖ 失败 ${problems.length} 项:`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
  console.log('报告: artifacts/desktop/window-state-check.json');
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('checkWindowState 崩了：');
  console.error(error);
  process.exitCode = 1;
});
