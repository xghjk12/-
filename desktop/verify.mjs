import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pw from 'playwright-core';
import electronPath from 'electron';
import windowStateModule from './windowState.js';

const { isOnDisplays, MIN_VISIBLE_PX } = windowStateModule;

/**
 * 桌面端总验收（t3 四条 + t7 三组新能力），用 Playwright 驱动**真正的桌面端入口**。
 *
 * 沿用上一期（t3，原样保留、不退化）：
 *   1. 窗口能开，曲库列表有行（等布局稳定后再数，不是量首帧空 DOM）
 *   2. 双击一首歌**真的开始播**（audio 元素的 currentTime 在走，不是只有界面状态）
 *   3. 歌词面板能打开、有歌词行
 *   4. **隐藏窗口后音乐继续**：隐藏 3 秒、每 150ms 采样，窗口不可见期间音频仍在前进
 *   5. 附加：托盘「退出」→ exit 0、端口释放
 *
 * 本期新增（t7）：
 *   6. 补歌词链路（假工具，绝不联网）：settings.lyricsToolPath → running → done →
 *      自动重扫认领 → UI 通知「新认领 N」→ 歌词面板看到假工具写的句子；
 *      放歌中补歌词，音乐不能停（第一不变式）
 *   7. 补歌词失败路径：不存在/损坏的工具路径必须给出 failed + 可读错误（不许静默）
 *   8. 补歌词取消：慢工具 → 渲染进程 cancel() → 独立终态 cancelled → 进程树杀干净
 *   9. 托盘播放控制：**窗口隐藏时** play-pause×2 / next / prev 都作用到真实 audio，
 *      托盘文案随状态换向，主进程与渲染进程的 currentIndex 一致
 *  10. 窗口状态记忆：改几何→重启恢复；最大化状态保持；屏幕外存档（x=3000 / x=99999）
 *      → 回退到屏幕内；退出后存档不落垃圾坐标
 *
 * 每次运行使用隔离 profile（artifacts/desktop/userdata-verify*），不碰用户真实曲库。
 * 补歌词用 desktop/tools/fake-fill-lyrics.ps1 写一个确定内容的 .lrc，全程不联网。
 *
 * 用法（仓库根目录，先 pnpm build）：
 *   node desktop/verify.mjs
 *
 * 产物：artifacts/desktop/verify.json + verify-*.png
 */

const { _electron } = pw;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = __dirname;
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const ORIGIN = 'http://127.0.0.1:53140';
const USER_DATA_DIR = path.join(artifactsDir, 'userdata-verify');
const REPORT_PATH = path.join(artifactsDir, 'verify.json');
const EXPECTED_ROWS = 4; // 内置样本：sample-cn.flac / sample-cn.mp3 / fake.ape / plain.mp3
const HIDE_WAIT_MS = 3000;
const SAMPLE_INTERVAL_MS = 150;

// ---- t7：三组新能力的隔离目录 ----
const LYRICS_USER_DATA_DIR = path.join(artifactsDir, 'userdata-verify-lyrics');
const LYRICS_MUSIC_DIR = path.join(artifactsDir, 'verify-lyrics-music');
const WINDOW_USER_DATA_DIR = path.join(artifactsDir, 'userdata-verify-window');
const FAKE_TOOL = path.join(desktopDir, 'tools', 'fake-fill-lyrics.ps1');
const SLOW_MARKER = `QYVERIFYSLOW${process.pid}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 端口上是不是已经有东西在响应（= 已有实例在跑，本次无法启动）。 */
async function originResponds() {
  try {
    await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 断言失败时的现场：区分"首帧还没布局"与"真的错了"。
 * 只读 DOM/页面状态，不改变任何东西。
 */
async function diagnose(win) {
  if (!win) return { error: '没有拿到窗口' };
  try {
    return await win.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      appMounted: Boolean(document.querySelector('.app')),
      bodyChildren: document.body ? document.body.children.length : 0,
      rows: document.querySelectorAll('.row').length,
      emptyState: Boolean(document.querySelector('.empty')),
      selfTestVerdict: document.documentElement.dataset.selfTest ?? null,
      visibility: document.visibilityState,
      title: document.title,
      hasTestHooks: typeof window.__qingyinTest !== 'undefined',
      hasDesktopBridge: typeof window.qingyinDesktop !== 'undefined',
    }));
  } catch (error) {
    return { error: errorText(error) };
  }
}

/**
 * 桌面级证据：EnumWindows 转储当前所有**可见**顶层窗口。
 * 主进程说 isVisible()=false 还不够硬——顺便用 OS 的眼睛确认屏幕上真的没有它。
 */
function snapshotDesktop(tag) {
  return new Promise((resolve) => {
    const shotPath = path.join(artifactsDir, `verify-desktop-${tag}.png`);
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
    child.on('close', (code) => resolve({ code, out: out.trim(), shotPath }));
    child.on('error', (error) => resolve({ code: -1, out: String(error), shotPath }));
  });
}

/**
 * 播放采样：窗口隐藏时也照样能读（CDP 的 evaluate 不依赖窗口可见性，
 * 音频在渲染进程里继续跑）。
 *
 * 注意：Electron 的 `BrowserWindow.hide()` **不会**把 `document.visibilityState`
 * 变成 hidden（本机实测 21 次采样全是 visible）。所以页面可见性不能当"窗口隐藏"
 * 的判据——判据用主进程 `isVisible()` + OS 层 EnumWindows。
 */

async function samplePlayback(win) {
  return win.evaluate(() => ({
    visibility: document.visibilityState,
    paused: window.__qingyinTest.paused(),
    playing: window.__qingyinTest.state().playing,
    positionSec: window.__qingyinTest.positionSec(),
    durationSec: window.__qingyinTest.durationSec(),
    currentIndex: window.__qingyinTest.state().currentIndex,
    audioSrc: window.__qingyinTest.audioSrc(),
  }));
}

/**
 * 把一串采样压成"到底有没有在前进"的证据。
 *
 * 内置样本只有 1–2 秒，列表循环下会不断自动切歌，所以**不能**只比较首尾两个
 * positionSec（切歌会把位置归零，看起来像"没动"）。正确算法：
 *   - 同一首内：累加正增量（这就是真实播放掉的时间）
 *   - 发生切歌：说明上一首自然播完 → auto-next 本身就是"播放没停"的证据
 */
function summarizeSamples(samples) {
  let positiveDeltaSec = 0;
  let indexChanges = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const next = samples[i];
    if (next.currentIndex !== prev.currentIndex) {
      indexChanges += 1;
    } else if (next.positionSec > prev.positionSec) {
      positiveDeltaSec += next.positionSec - prev.positionSec;
    }
  }
  return {
    positiveDeltaSec: Number(positiveDeltaSec.toFixed(3)),
    indexChanges,
    pausedSamples: samples.filter((s) => s.paused).length,
    notPlayingSamples: samples.filter((s) => !s.playing).length,
  };
}

// ========================================================================
// t7 新增：多进程验证用的通用工具
// ========================================================================

/** 轮询直到 fn 返回真值；超时返回最后一次读数（失败不藏起来）。 */
async function waitFor(fn, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return last;
    await sleep(intervalMs);
  }
}

function menuItemOf(state, id) {
  return (state?.menu ?? []).find((item) => item.id === id) ?? null;
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function readSettingsFromDisk(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** 用 node 侧直接写 settings.json（模拟"用户之前选过的设置"）。 */
function writeSettingsFile(userDataDir, settings) {
  cleanDir(userDataDir);
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** 只改 windowState 键（其余键原样保留——t6 的部分更新语义）。 */
function writeWindowStateToSettings(userDataDir, windowState) {
  const current = fs.existsSync(path.join(userDataDir, 'settings.json'))
    ? readSettingsFromDisk(userDataDir)
    : {};
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    `${JSON.stringify({ ...current, windowState }, null, 2)}\n`,
    'utf8',
  );
}

/** 启动一次（不做重试）：返回 app/win/本次会话的渲染进程报错。 */
async function launchOnce(userDataDir, tag, log) {
  const env = { ...process.env };
  // 坑 1（README §5）：DSH 终端会把这个变量传给子进程，带着它 electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, '--no-sandbox', `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env,
    timeout: 60000,
  });
  app.process().stdout?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log(`[${tag}] ${line.trimEnd()}`);
  });
  app.process().stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log(`[${tag}:err] ${line.trimEnd()}`);
  });
  const win = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  win.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${tag}: ${message.text()}`);
  });
  win.on('pageerror', (error) => errors.push(`${tag}: pageerror: ${error.message}`));
  await win.waitForLoadState('domcontentloaded');
  return { app, win, errors };
}

/**
 * 启动（带重试）。
 *
 * 这台机器连续多次启动 Electron 时，Playwright 的 CDP 连接偶尔会在应用已经
 * 正常起来之后被重置（ECONNRESET，主进程日志显示 origin 已打印）——不是产品问题，
 * 是调试通道抖动。一个脚本要连开八九次进程，所以重试，但每次失败都记进报告。
 */
async function launchWithRetry(userDataDir, tag, log) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await launchOnce(userDataDir, tag, log);
    } catch (error) {
      lastError = error;
      const firstLine = errorText(error).split('\n')[0];
      log(`[${tag}] 第 ${attempt} 次启动失败：${firstLine}`);
      console.log(`    ! ${tag} 第 ${attempt} 次启动失败（${firstLine}），2 秒后重试`);
      await sleep(2000);
    }
  }
  throw lastError;
}

/** 走托盘「退出」那条真退出路径（会触发退出前落盘）。 */
async function quitApp(app) {
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 20000);
    app.process().once('exit', (exitCode) => {
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
  // 等 53140 真正释放再让下一幕启动：origin 是固定端口（不换端口），
  // 连开九次进程时如果抢在 TIME_WAIT/LISTEN 之间，下一幕会撞 EADDRINUSE。
  if (code === 0) {
    for (let i = 0; i < 50; i += 1) {
      if (!(await originResponds())) break;
      await sleep(100);
    }
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
      displays: screen.getAllDisplays().map((display) => ({
        workArea: display.workArea,
        bounds: display.bounds,
      })),
    };
  });
}

/** 几何比对：Windows 的边框/阴影可能让读数差几个像素，给一点容差。 */
function closeEnough(actual, expected, tolerance = 8) {
  if (!actual || !expected) return false;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Math.abs((actual[key] ?? NaN) - expected[key]) > tolerance) return false;
  }
  return true;
}

function startDialogDriver(pickPath) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(desktopDir, 'driveFolderDialog.ps1'), '-WatchSec', '55'],
    { cwd: repoRoot, env: { ...process.env, QINGYIN_PICK_PATH: pickPath }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(`    [对话框驱动] ${line.trimEnd()}`);
  });
  return child;
}

/** 失败工具：存在、能启动、但退出码 5 + 可读错误（不联网、不写文件）。 */
function generateBrokenTool() {
  const scriptPath = path.join(artifactsDir, 'verify-broken-lyrics-tool.ps1');
  // \uFEFF = UTF-8 BOM：PS 5.1 读无 BOM 脚本会按 ANSI/GBK 解码，中文变乱码
  fs.writeFileSync(
    scriptPath,
    '\uFEFF' +
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
      "[Console]::Error.WriteLine('VERIFY-FAIL-TOOL: 模拟工具内部错误（退出码 5）')\n" +
      'exit 5\n',
    'utf8',
  );
  return scriptPath;
}

/** 慢工具：拉一个带 marker 的子进程睡 90 秒（取消要连整棵树杀掉）。 */
function generateSlowTool() {
  const scriptPath = path.join(artifactsDir, 'verify-slow-lyrics-tool.ps1');
  fs.writeFileSync(
    scriptPath,
    '\uFEFF' +
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
      "Write-Output 'VERIFY-SLOW started'\n" +
      `Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','Write-Output ${SLOW_MARKER}; Start-Sleep -Seconds 90' -Wait\n` +
      'exit 0\n',
    'utf8',
  );
  return scriptPath;
}

/** 取消后查进程表：命令行带 marker 的进程数——0 才算杀干净。 */
async function countProcessTree(marker) {
  await sleep(3000); // 给 taskkill 留时间
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | Measure-Object).Count`,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    return Number.parseInt(out.trim(), 10) || 0;
  } catch {
    return -1; // 查询失败不能静默当 0
  }
}

/** 重建假工具用的曲库目录（唯一一首音频，没有 .lrc）。 */
function prepareLyricsMusicFolder() {
  fs.rmSync(LYRICS_MUSIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(LYRICS_MUSIC_DIR, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'tests', 'fixtures', 'sample-cn.mp3'),
    path.join(LYRICS_MUSIC_DIR, 'sample-cn.mp3'),
  );
  return 'sample-cn.mp3';
}

/** 等主进程侧工具状态到目标值（超时返回最后状态，不假装成功）。 */
async function waitForLyricsState(app, target, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await app.evaluate(() => globalThis.__qingyinDesktopShell.lyricsState());
    if (last && last.status === target) return last;
    await sleep(200);
  }
  return last;
}

async function main() {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // ---- 前置检查：别把"环境没准备好"误报成产品缺陷 ----
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
    console.error('找不到 dist/index.html：先在仓库根目录 pnpm build');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(electronPath)) {
    console.error(`找不到 Electron 二进制：${electronPath}\n先跑 node desktop/installElectron.js`);
    process.exitCode = 2;
    return;
  }
  if (await originResponds()) {
    console.error(
      `端口 ${ORIGIN} 已有实例在响应。\n` +
        '桌面端 origin 是固定端口（不换端口），验证前请先**完全退出**正在跑的轻音播放（含托盘「退出」）。',
    );
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  // 隔离 profile：不碰用户真实曲库；每次从干净状态开始，样本数量才是确定的
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const env = { ...process.env };
  // 坑 1（README §5）：DSH 终端会把这个变量传给子进程，带着它 electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;

  const launchArgs = [desktopDir, '--no-sandbox', `--user-data-dir=${USER_DATA_DIR}`];
  console.log(`electron : ${electronPath}`);
  console.log(`app dir  : ${desktopDir}`);
  console.log(`origin   : ${ORIGIN}`);
  console.log(`profile  : ${path.relative(repoRoot, USER_DATA_DIR)}（隔离，不影响真实曲库）`);

  const app = await _electron.launch({
    executablePath: electronPath,
    args: launchArgs,
    cwd: repoRoot,
    env,
    timeout: 60000,
  });

  const problems = [];
  const warnings = [];
  const facts = { startedAt, launchArgs, electronVersion: process.versions.electron };
  const consoleErrors = [];
  const mainLog = [];
  // t7：把每条断言按「沿用上一期 / 本期新增」分组记进报告——
  // 让复核的人一眼看出有没有退化、新增的到底验了什么。
  const assertions = [];
  let currentGroup = 'inherited';

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

  let win = null;

  /** 断言：立即打印，失败记进 problems（不中断）；同时按分组记进报告。 */
  function check(condition, label, evidence) {
    const ok = Boolean(condition);
    assertions.push({ group: currentGroup, label, ok });
    console.log(`  ${ok ? '✔' : '✖'} ${label}${evidence !== undefined ? ` — ${JSON.stringify(evidence)}` : ''}`);
    if (!ok) problems.push(label);
    return ok;
  }

  /**
   * t7 新增能力的一段验证：自己启动/退出独立的 Electron 进程。
   * 失败只记 problems（不中断后面的组），并把该组断言标记为「本期新增」。
   */
  async function session(name, fn) {
    const previousGroup = currentGroup;
    currentGroup = 'added';
    console.log(`\n== ${name} ==`);
    try {
      await fn();
    } catch (error) {
      problems.push(`${name}：${errorText(error)}`);
      console.error(`  ✖ ${name} 未完成：${errorText(error)}`);
    } finally {
      currentGroup = previousGroup;
    }
  }

  const logMain = (line) => {
    mainLog.push(line);
    console.log(`    ${line}`);
  };

  /** 一个阶段：抛异常时留下现场诊断，并把失败记进 problems。 */
  async function stage(name, fn, group = 'inherited') {
    const previousGroup = currentGroup;
    currentGroup = group;
    console.log(`\n== ${name} ==`);
    try {
      await fn();
      return true;
    } catch (error) {
      const diag = await diagnose(win);
      facts[`diagnostics@${name}`] = diag;
      problems.push(`${name}：${errorText(error)}`);
      console.error(`  ✖ ${name} 未完成：${errorText(error)}`);
      console.error(`    现场诊断：${JSON.stringify(diag)}`);
      return false;
    } finally {
      currentGroup = previousGroup;
    }
  }

  try {
    win = await app.firstWindow({ timeout: 60000 });
    win.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    win.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await win.waitForLoadState('domcontentloaded');
    // ?selftest=1 才会装 window.__qingyinTest（正式入口不挂，见 checkWindow.js 的断言）
    await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
    await win.waitForSelector('.app', { timeout: 60000 });

    // 内置自检会临时塞 500 首合成曲目、量完再还原（selfCheck.ts）。
    // 必须等它跑完再数行，否则可能量到那一瞬间的合成列表——这正是
    // "虚拟化偶发 false / rows 偶发不等于预期" 的根源（README §3.7）。
    let selfCheck = { verdict: 'timeout', failed: [] };
    try {
      await win.waitForFunction(
        () => Boolean(document.documentElement.dataset.selfTest),
        null,
        { timeout: 120000 },
      );
      selfCheck = await win.evaluate(() => ({
        verdict: document.documentElement.dataset.selfTest ?? 'unknown',
        failed: Array.from(document.querySelectorAll('#selfTestResult tr'))
          .filter((tr) => (tr.lastElementChild?.textContent ?? '').includes('不通过'))
          .map((tr) => tr.firstElementChild?.textContent ?? ''),
      }));
    } catch (error) {
      warnings.push(`内置自检没有给出结论（${errorText(error)}），继续验证桌面端本身`);
    }
    facts.selfCheck = selfCheck;
    console.log(`\n内置自检：${selfCheck.verdict}${selfCheck.failed.length ? `（失败项：${selfCheck.failed.join('、')}）` : ''}`);
    if (selfCheck.verdict !== 'pass') {
      // 已知偶发：Electron 首帧量虚拟化可能失败。这里不去追它，
      // 只如实记一条警告——t3 的四条判定与它无关，不能拿它当遮羞布也不拿它当替罪羊。
      const onlyVirtualization =
        selfCheck.failed.length === 1 && selfCheck.failed[0].includes('虚拟化');
      warnings.push(
        onlyVirtualization
          ? '内置自检仅「虚拟化」一项未通过（已知首帧偶发，已等布局稳定后再量；t3 四条不依赖它）'
          : `内置自检存在失败项：${selfCheck.failed.join('、') || '自检未给出明细'}`,
      );
    }
    // 自检结果面板是 ?selftest=1 专用的浮层，会拦截鼠标事件（实测把抽屉关闭按钮
    // 盖住了）。真实用户走的是不带参数的入口、根本没有这个节点；这里量完结论就摘掉它，
    // 后续点击/截图才和用户看到的一致。
    await win.evaluate(() => {
      document.getElementById('selfTestResult')?.remove();
    });

    // ---------- 1) 窗口 + 列表 ----------
    const windowStageOk = await stage('1) 窗口能开、曲库列表有行', async () => {
      const shellState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
      facts.shellStateAtBoot = shellState;
      const windows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          title: w.getTitle(),
          visible: w.isVisible(),
          destroyed: w.isDestroyed(),
        })),
      );
      facts.windowsAtBoot = windows;

      const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
      check(windows.length === 1 && windows[0].visible, '窗口已打开且可见', windows);
      check(
        new RegExp(`轻音播放 v${version.replace(/\./g, '\\.')}$`).test(windows[0]?.title ?? ''),
        '原生窗口标题带版本号',
        { title: windows[0]?.title, version },
      );

      const imported = await win.evaluate(() => window.__qingyinTest.loadFixtureLibrary());
      facts.fixtureTracks = imported;

      // **关键顺序**：先等界面长出内容（.row 或 .empty），再等行数稳定，最后才数。
      // 只等 domcontentloaded 就数，量到的是 React 还没挂载的空 DOM（rows=0），
      // 这个坑在 t1 的 checkWindow.js 里已经踩过一次，别再复现。
      await win.waitForSelector('.row, .empty', { timeout: 60000 });
      await win.waitForFunction(
        (expected) => document.querySelectorAll('.row').length >= expected,
        EXPECTED_ROWS,
        { timeout: 60000 },
      );
      // 再让一帧过去，确保虚拟化列表在稳定视口里完成一次布局
      await win.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
      );

      const library = await win.evaluate(() => ({
        origin: location.origin,
        isSecureContext: window.isSecureContext,
        rows: document.querySelectorAll('.row').length,
        titles: Array.from(document.querySelectorAll('.row .title-main')).map((node) => node.textContent.trim()),
        emptyState: Boolean(document.querySelector('.empty')),
        hasDesktopBridge: typeof window.qingyinDesktop?.info === 'function',
      }));
      facts.library = library;

      check(library.origin === ORIGIN, 'origin 是固定的回环地址', { origin: library.origin });
      check(library.isSecureContext, '页面是安全上下文（IndexedDB 可用）');
      check(library.hasDesktopBridge, 'preload 暴露了 window.qingyinDesktop.info');
      check(!library.emptyState, '不是空状态界面');
      check(library.rows >= EXPECTED_ROWS, `列表有行（≥ ${EXPECTED_ROWS}）`, {
        rows: library.rows,
        titles: library.titles,
      });
      check(imported === EXPECTED_ROWS, `内置样本 ${EXPECTED_ROWS} 首全部入库`, { imported });

      await win.screenshot({ path: path.join(artifactsDir, 'verify-library.png') });
    });

    if (!windowStageOk) {
      throw new Error('窗口/列表没有通过，后面的播放与隐藏验证没有意义，终止');
    }

    // ---------- 2) 双击真的开始播 ----------
    const playbackStageOk = await stage('2) 双击曲目后真的开始播放', async () => {
      // 选 plain 这一首：它带 plain.lrc（3 行歌词），下一步的歌词面板也用它
      const plainRow = win.locator('.row', { hasText: 'plain' }).first();
      await plainRow.dblclick({ timeout: 15000 });
      await win.waitForFunction(
        () => !window.__qingyinTest.paused() && window.__qingyinTest.positionSec() > 0.05,
        null,
        { timeout: 20000 },
      );

      const playing = await samplePlayback(win);
      facts.playing = playing;
      check(!playing.paused && playing.playing, 'audio 元素未暂停且 store 状态为播放中', {
        paused: playing.paused,
        playing: playing.playing,
      });
      check(playing.positionSec > 0.05, '播放位置在前进', {
        positionSec: playing.positionSec,
        durationSec: playing.durationSec,
      });
      check(Boolean(playing.audioSrc), 'audio 有真实 src（不是空元素）', {
        srcPrefix: playing.audioSrc.slice(0, 32),
      });
      const trackPath = await win.evaluate(
        () => window.__qingyinTest.state().resumePath ?? window.__qingyinTest.tracks()[window.__qingyinTest.state().currentIndex] ?? '',
      );
      facts.playingTrack = trackPath;
      check(/plain\.mp3$/.test(trackPath), '当前播放的是 plain.mp3', { trackPath });
    });

    // ---------- 3) 歌词面板 ----------
    let lyricsStageOk = false;
    if (playbackStageOk) {
      lyricsStageOk = await stage('3) 歌词面板能打开并有行', async () => {
        // 走真实的侧栏入口（和用户点「歌词」完全同一条路径）
        await win.locator('.nav-item', { hasText: '歌词' }).first().click({ timeout: 10000 });
        await win.waitForSelector('.drawer .lyrics', { timeout: 15000 });
        await win.waitForSelector('.drawer .lyric-line', { timeout: 15000 });

        const panel = await win.evaluate(() => ({
          open: Boolean(document.querySelector('.drawer')),
          title: document.querySelector('.lyrics-title')?.textContent?.trim() ?? '',
          lines: Array.from(document.querySelectorAll('.drawer .lyric-line')).map((node) => node.textContent.trim()),
          emptyOrMissing: Boolean(document.querySelector('.lyrics-empty, .lyrics-missing')),
        }));
        facts.lyricsPanel = panel;
        check(panel.open, '歌词抽屉已打开');
        check(!panel.emptyOrMissing, '面板不是「还没有歌词」的占位状态');
        check(panel.lines.length === 3, 'plain.lrc 的三行歌词都渲染出来', { lines: panel.lines });
        check(panel.lines.every((line) => line.length > 0), '歌词行不是空字符串');
        check(panel.title === 'plain', '歌词面板标题是当前曲目', { title: panel.title });

        await win.screenshot({ path: path.join(artifactsDir, 'verify-lyrics.png') });

        // 收起抽屉，把版面还给列表（不收起也不影响播放，只是下一步截图更干净）
        await win.locator('.drawer .btn-icon[title="关闭"]').first().click({ timeout: 10000 });
      });
    } else {
      warnings.push('播放没起来，歌词面板跳过（没有当前曲目时它只会显示占位状态）');
    }

    // ---------- 4) 核心：隐藏窗口后音乐继续 ----------
    let hiddenStageOk = false;
    if (playbackStageOk) {
      hiddenStageOk = await stage('4) 隐藏窗口后音乐继续（核心）', async () => {
        // 内置样本只有 1–2 秒：切列表循环，否则队列 8 秒就放完停下，
        // "3 秒后还在放"会被误判成失败（checkTray 里也做了同样处理）
        const mode = await win.evaluate(() => {
          const test = window.__qingyinTest;
          for (let i = 0; i < 5; i += 1) {
            if (test.state().mode === 'repeat-all') break;
            test.cycleMode();
          }
          return test.state().mode;
        });
        facts.playbackMode = mode;
        check(mode === 'repeat-all', '播放模式 = 列表循环（长测不会被 1–2 秒样本卡死）', { mode });

        // 换一首 2 秒的（列表第一行）再测隐藏，采样窗口里切歌更少、证据更直白
        await win.locator('.row').first().dblclick({ timeout: 15000 });
        await win.waitForFunction(
          () => !window.__qingyinTest.paused() && window.__qingyinTest.positionSec() > 0.05,
          null,
          { timeout: 20000 },
        );
        const baseline = await samplePlayback(win);
        facts.beforeHide = baseline;
        check(!baseline.paused && baseline.playing, '隐藏前正在播放', {
          positionSec: baseline.positionSec,
          currentIndex: baseline.currentIndex,
        });

        // 托盘「隐藏窗口」菜单项调用的就是 hideMainWindow()（main.js 的同一份代码）
        await app.evaluate(() => globalThis.__qingyinDesktopShell.hideMainWindow());
        const hiddenState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
        facts.shellStateHidden = hiddenState;
        const toggleLabel = (hiddenState.menu ?? []).find((item) => item.id === 'toggle-window')?.label;
        check(hiddenState.windowVisible === false, '窗口已隐藏（主进程 isVisible() = false）');
        check(hiddenState.windowExists === true, '窗口对象还在（hide，不是销毁）');
        check(hiddenState.isQuitting === false, '隐藏不触发退出流程');
        check(toggleLabel === '显示窗口', '托盘菜单文案翻成「显示窗口」', { toggleLabel });

        // 3 秒里每 150ms 采一次：窗口不可见期间 currentTime 必须一直往前走
        const samples = [baseline];
        const hideStart = Date.now();
        while (Date.now() - hideStart < HIDE_WAIT_MS) {
          await sleep(SAMPLE_INTERVAL_MS);
          samples.push(await samplePlayback(win));
        }
        const elapsedMs = Date.now() - hideStart;
        const summary = summarizeSamples(samples);
        facts.hideSamples = {
          elapsedMs,
          count: samples.length,
          summary,
          pageVisibility: Array.from(new Set(samples.map((s) => s.visibility))),
          last: samples[samples.length - 1],
        };

        check(elapsedMs >= HIDE_WAIT_MS, '观察窗口 ≥ 3 秒', { elapsedMs, samples: samples.length });
        // 注意：这里不断言 document.visibilityState —— Electron 的 hide() 不改变它
        //（实测全 visible），拿它当判据会写出一个永远失败的假断言。
        // "窗口真的不在屏幕上"用 OS 层证据：EnumWindows 的可见窗口清单里没有轻音播放。
        const desktop = await snapshotDesktop('hidden');
        facts.desktopWhileHidden = { code: desktop.code, dump: desktop.out.slice(0, 4000) };
        if (desktop.code !== 0) {
          warnings.push(`桌面快照失败（不影响播放判定）：${desktop.out.slice(0, 200)}`);
        } else {
          const qyWindows = desktop.out
            .split('\n')
            .map((line) => line.trim())
            .filter(
              (line) =>
                line.startsWith('WINDOW:') && line.includes('轻音播放') && line.includes('proc=electron'),
            );
          check(qyWindows.length === 0, 'OS 可见窗口清单里没有轻音播放（屏幕上真的没有它）', {
            matches: qyWindows.join(' ; ') || '(无)',
            shot: path.basename(desktop.shotPath),
          });
        }
        check(summary.pausedSamples === 0, '隐藏期间 audio 元素一次都没暂停', {
          pausedSamples: summary.pausedSamples,
        });
        check(summary.notPlayingSamples === 0, '隐藏期间 store 状态一直是播放中', {
          notPlayingSamples: summary.notPlayingSamples,
        });
        check(
          summary.positiveDeltaSec >= 1.0 || summary.indexChanges > 0,
          '隐藏 3 秒内播放位置在增长（或自动切歌 = 上一首真的放完了）',
          { positiveDeltaSec: summary.positiveDeltaSec, indexChanges: summary.indexChanges },
        );
        check(Boolean(samples[samples.length - 1].audioSrc), '隐藏期间 audio 仍有有效 src', {
          srcPrefix: samples[samples.length - 1].audioSrc.slice(0, 32),
        });

        // 显示回来：窗口恢复、音乐还在（用户从托盘叫回窗口时的真实体验）
        await app.evaluate(() => globalThis.__qingyinDesktopShell.showMainWindow());
        const shownState = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
        facts.shellStateShown = shownState;
        check(shownState.windowVisible === true, '从托盘再显示后窗口可见');
        const afterShowA = await samplePlayback(win);
        await sleep(600);
        const afterShowB = await samplePlayback(win);
        facts.afterShow = { a: afterShowA, b: afterShowB };
        check(!afterShowB.paused && afterShowB.playing, '显示回来后仍在播放');
        check(
          (afterShowB.currentIndex === afterShowA.currentIndex &&
            afterShowB.positionSec > afterShowA.positionSec) ||
            afterShowB.currentIndex !== afterShowA.currentIndex,
          '显示回来后播放位置仍在前进',
          {
            before: { positionSec: afterShowA.positionSec, index: afterShowA.currentIndex },
            after: { positionSec: afterShowB.positionSec, index: afterShowB.currentIndex },
          },
        );

        // 反证（防止上一条断言空转）：同一套采样在**暂停**时必须量不出前进。
        // 如果暂停后还能"量到增长"，说明我们测的根本不是播放进度。
        await win.evaluate(() => {
          if (!window.__qingyinTest.paused()) window.__qingyinTest.togglePlay();
        });
        await win.waitForFunction(() => window.__qingyinTest.paused(), null, { timeout: 10000 });
        const pausedA = await samplePlayback(win);
        await sleep(700);
        const pausedB = await samplePlayback(win);
        facts.negativeControl = { pausedA, pausedB };
        check(pausedB.paused === true, '反证：已暂停（audio.paused = true）');
        check(
          Math.abs(pausedB.positionSec - pausedA.positionSec) < 0.05,
          '反证：暂停后同一采样窗口量不到前进（说明"隐藏后仍在增长"不是空转）',
          {
            before: pausedA.positionSec,
            after: pausedB.positionSec,
            deltaSec: Number(Math.abs(pausedB.positionSec - pausedA.positionSec).toFixed(3)),
          },
        );

        await win.screenshot({ path: path.join(artifactsDir, 'verify-after-hide.png') });
      });
    } else {
      warnings.push('播放没起来，隐藏后继续播放无法验证');
    }

    // ---------- 5) t7 新增：托盘播放控制（窗口隐藏态） ----------
    // 第一阶段已证明「隐藏后音乐继续」；这里证明**隐藏时还能控制**：
    // 主进程 sendPlaybackCommand → webContents.send → 渲染进程只调 store 既有动作。
    // 命令走 __qingyinDesktopShell.playbackCommand()——托盘菜单项 click 调用的同一个函数。
    await stage('5) 托盘播放控制（窗口隐藏时）', async () => {
      // 0) 先恢复播放：上一阶段的反证把音频暂停了，这里要验的正是「播放/暂停」两向。
      //    切单曲循环，避免 1–2 秒样本自动切歌把 next/prev 的读数搞乱
      await win.evaluate(() => {
        const test = window.__qingyinTest;
        for (let i = 0; i < 5; i += 1) {
          if (test.state().mode === 'repeat-one') break;
          test.cycleMode();
        }
      });
      const mode = await win.evaluate(() => window.__qingyinTest.state().mode);
      check(mode === 'repeat-one', '播放模式锁成单曲循环（短样本不会自动切歌干扰下标断言）', { mode });

      const send = async (type) => {
        // 注意：ElectronApplication.evaluate 的第一个参数永远是 electron 模块，
        // 第二个才是传进去的 arg（checkTrayPlayback.js 踩过的坑）
        const result = await app.evaluate(
          (_electron, commandType) => globalThis.__qingyinDesktopShell.playbackCommand(commandType),
          type,
        );
        check(result?.ok === true, `托盘命令已送达渲染进程：${type}`, result);
        return result;
      };
      const readPaused = () => win.evaluate(() => window.__qingyinTest.paused());
      const readRendererIndex = () => win.evaluate(() => window.__qingyinTest.state().currentIndex);
      const readStatus = () => app.evaluate(() => globalThis.__qingyinDesktopShell.readPlaybackStatus());
      const readShell = () => app.evaluate(() => globalThis.__qingyinDesktopShell.readState());

      // 1) 先让播放恢复（窗口可见时发一次，确认命令通道本身是通的）
      await send('play-pause');
      const resumed = await waitFor(async () => ((await readPaused()) === false ? true : null), 10000);
      check(Boolean(resumed), '命令通道可用：play-pause 让音频从暂停恢复', { paused: await readPaused() });

      // 2) 隐藏窗口——后面每一条命令都在隐藏态下发
      await app.evaluate(() => globalThis.__qingyinDesktopShell.hideMainWindow());
      const hiddenAtStart = await readShell();
      check(hiddenAtStart.windowVisible === false, '控制前窗口已隐藏（isVisible=false）', {
        windowVisible: hiddenAtStart.windowVisible,
      });

      // 3) 暂停：audio + 主进程状态 + 托盘文案三处都要变
      const pausedBefore = await readPaused();
      await send('play-pause');
      const pausedAfter = await waitFor(async () => ((await readPaused()) === true ? true : null), 10000);
      const statusPaused = await readStatus();
      const labelPaused = await waitFor(
        async () => {
          const state = await readShell();
          return menuItemOf(state, 'play-pause')?.label === '播放' ? '播放' : null;
        },
        10000,
      );
      facts.trayControlPause = { pausedBefore, pausedAfter: await readPaused(), statusPaused, labelPaused };
      check(pausedBefore === false && Boolean(pausedAfter), '隐藏时点「暂停」→ audio.paused 由 false 变 true', {
        before: pausedBefore,
        after: await readPaused(),
      });
      check(statusPaused?.playing === false, '主进程侧收到上报：playing=false', statusPaused);
      check(labelPaused === '播放', '托盘菜单文案随状态换成「播放」', { label: labelPaused });

      // 4) 播放：反向再变一次（证明不是"只能暂停"的一次性状态）
      await send('play-pause');
      const resumedAfter = await waitFor(async () => ((await readPaused()) === false ? true : null), 10000);
      const statusPlaying = await readStatus();
      const labelPlaying = await waitFor(
        async () => {
          const state = await readShell();
          return menuItemOf(state, 'play-pause')?.label === '暂停' ? '暂停' : null;
        },
        10000,
      );
      facts.trayControlPlay = { resumedAfter: await readPaused(), statusPlaying, labelPlaying };
      check(Boolean(resumedAfter), '隐藏时再点「播放」→ audio.paused 由 true 变回 false', {
        paused: await readPaused(),
      });
      check(statusPlaying?.playing === true, '主进程侧收到上报：playing=true', statusPlaying);
      check(labelPlaying === '暂停', '托盘菜单文案换回「暂停」', { label: labelPlaying });

      // 5) 下一首：主进程记录的下标与渲染进程 store 必须一致，队列不能被搞乱
      const queueBefore = await win.evaluate(() => ({
        length: window.__qingyinTest.state().queueLength,
        tracks: window.__qingyinTest.tracks(),
      }));
      const indexBeforeNext = (await readStatus())?.currentIndex;
      await send('next');
      const indexAfterNext = await waitFor(
        async () => {
          const index = (await readStatus())?.currentIndex;
          return Number.isInteger(index) && index !== indexBeforeNext ? index : null;
        },
        15000,
      );
      const rendererAfterNext = await readRendererIndex();
      const queueAfter = await win.evaluate(() => ({
        length: window.__qingyinTest.state().queueLength,
        tracks: window.__qingyinTest.tracks(),
      }));
      facts.trayControlNext = { indexBeforeNext, indexAfterNext, rendererAfterNext, queueBefore, queueAfter };
      check(
        Number.isInteger(indexAfterNext) &&
          indexAfterNext === (indexBeforeNext + 1) % Math.max(1, queueBefore.length),
        '隐藏时点「下一首」→ 下标按队列前进一位',
        { before: indexBeforeNext, after: indexAfterNext, queueLength: queueBefore.length },
      );
      check(rendererAfterNext === indexAfterNext, '主进程记录与渲染进程 store 的下标一致', {
        rendererAfterNext,
        mainIndex: indexAfterNext,
      });
      check(
        queueAfter.length === queueBefore.length &&
          JSON.stringify(queueAfter.tracks) === JSON.stringify(queueBefore.tracks),
        '切歌没有搞乱队列（长度与曲目顺序不变）',
        { before: queueBefore.length, after: queueAfter.length },
      );

      // 6) 上一首：回到切歌前那一首
      await send('prev');
      const indexAfterPrev = await waitFor(
        async () => {
          const index = (await readStatus())?.currentIndex;
          return Number.isInteger(index) && index !== indexAfterNext ? index : null;
        },
        15000,
      );
      facts.trayControlPrev = { indexAfterNext, indexAfterPrev };
      check(indexAfterPrev === indexBeforeNext, '隐藏时点「上一首」→ 回到切歌前的那一首', {
        expected: indexBeforeNext,
        actual: indexAfterPrev,
      });

      // 7) 非白名单命令必须被主进程挡住
      const bogus = await app.evaluate(() => globalThis.__qingyinDesktopShell.playbackCommand('quit'));
      check(bogus?.ok === false, '非白名单命令被拒绝（不会把 quit 当播放命令发出去）', bogus);

      // 8) 全程窗口都是隐藏的；显示回来后仍在播
      const hiddenAtEnd = await readShell();
      check(hiddenAtEnd.windowVisible === false && hiddenAtEnd.windowExists === true, '整组命令期间窗口一直隐藏且未销毁', {
        windowVisible: hiddenAtEnd.windowVisible,
        windowExists: hiddenAtEnd.windowExists,
      });
      await app.evaluate(() => globalThis.__qingyinDesktopShell.showMainWindow());
      const shownAgain = await readShell();
      check(shownAgain.windowVisible === true && (await readPaused()) === false, '显示回来后窗口可见且仍在播放', {
        windowVisible: shownAgain.windowVisible,
        paused: await readPaused(),
      });
    }, 'added');

    // ---------- 6) 附加：托盘「退出」= 真退出（t2/t3 覆盖，这里顺带复验） ----------
    await stage('6) 附加：托盘「退出」', async () => {
      const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 20000);
        app.process().once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        app.evaluate(() => globalThis.__qingyinDesktopShell.quit());
      });
      facts.quitExit = exitCode;
      check(exitCode === 0, '托盘「退出」→ 进程 exit 0', { exitCode });

      let portClosed = false;
      for (let i = 0; i < 20; i += 1) {
        await sleep(250);
        if (!(await originResponds())) {
          portClosed = true;
          break;
        }
      }
      check(portClosed, '退出后 53140 端口已释放');
    });

    if (playbackStageOk && lyricsStageOk && hiddenStageOk) {
      check(consoleErrors.length === 0, '全程零渲染进程报错', {
        errors: consoleErrors.slice(0, 5),
      });
    }

    // ==================================================================
    // t7 新增能力（独立进程；每组都用隔离 profile）
    // ==================================================================

    // ---------- 7) 补歌词链路 · 成功（假工具，绝不联网） ----------
    await session('7) 补歌词链路 · 成功（假工具）', async () => {
      prepareLyricsMusicFolder();
      writeSettingsFile(LYRICS_USER_DATA_DIR, {
        openAtLogin: false,
        lyricsToolPath: FAKE_TOOL,
        musicFolderPath: LYRICS_MUSIC_DIR,
      });
      const { app: lyricsApp, win: lyricsWin, errors: lyricsErrors } = await launchWithRetry(
        LYRICS_USER_DATA_DIR,
        'lyrics-success',
        logMain,
      );
      let dialogDriver = null;
      try {
        await lyricsWin.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
        await lyricsWin.waitForSelector('.row, .empty', { timeout: 60000 });

        // 曲库必须走真实目录选择：selftest 的内存 File 没有磁盘路径，
        // 假工具写盘之后 rescan 扫不到（这也是 checkLyricsTool 的结论）。
        dialogDriver = startDialogDriver(LYRICS_MUSIC_DIR);
        await lyricsWin.locator('button:has-text("选择音乐文件夹")').first().click({ timeout: 15000 });
        const scanned = await waitFor(
          async () => {
            const scan = await lyricsWin.evaluate(() => window.__qingyinTest?.scan());
            const rows = await lyricsWin.evaluate(() => document.querySelectorAll('.row').length);
            return scan && !scan.active && scan.found >= 1 && rows >= 1 ? { scan, rows } : null;
          },
          60000,
          500,
        );
        facts.lyricsScan = scanned ? { found: scanned.scan.found, rows: scanned.rows } : null;
        check(Boolean(scanned), '真实目录选择：曲库扫描完成（≥1 首）', facts.lyricsScan);
        if (!scanned) throw new Error('曲库没扫进来，补歌词链路无法继续（原生对话框驱动失败？）');

        const trackPath = await lyricsWin.evaluate(() => window.__qingyinTest.tracks()[0]);
        facts.lyricsTrackPath = trackPath;

        // 先把音乐放起来：补歌词 + 自动重扫都**不许打断播放**（项目第一不变式）
        await lyricsWin.evaluate(() => {
          const test = window.__qingyinTest;
          for (let i = 0; i < 5; i += 1) {
            if (test.state().mode === 'repeat-all') return;
            test.cycleMode();
          }
        });
        await lyricsWin.locator('.row').first().dblclick({ timeout: 15000 });
        const playingBefore = await waitFor(
          async () => ((await lyricsWin.evaluate(() => window.__qingyinTest.paused())) === false ? true : null),
          20000,
        );
        check(Boolean(playingBefore), '补歌词前：双击曲目已在播放', {
          paused: await lyricsWin.evaluate(() => window.__qingyinTest.paused()),
        });

        // 触发 = 托盘「补歌词…」菜单项 click 调用的同一个函数
        const trigger = await lyricsApp.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
        facts.lyricsTrigger = {
          ok: trigger.ok,
          reason: trigger.reason,
          scriptPath: trigger.scriptPath,
          status: trigger.status?.status,
        };
        check(trigger.ok === true, '补歌词已启动（triggerFillLyrics 走真实路径）', {
          scriptPath: trigger.scriptPath,
        });
        check(trigger.status?.status === 'running', '触发后主进程状态为 running', {
          status: trigger.status?.status,
        });
        check(
          typeof trigger.scriptPath === 'string' && trigger.scriptPath.endsWith('fake-fill-lyrics.ps1'),
          '用的是假工具（settings.lyricsToolPath 生效，不碰真实 LyricFlow）',
          { scriptPath: trigger.scriptPath },
        );

        // 一条循环里同时抓：状态序列 / 通知文案 / 渲染进程认领。
        // 通知 3.2 秒自动消失，分开轮询容易漏（checkLyricsTool 的经验）。
        const statuses = [trigger.status?.status].filter(Boolean);
        const notices = [];
        let claimed = null;
        let finalState = null;
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          const state = await lyricsApp.evaluate(() => globalThis.__qingyinDesktopShell.lyricsState());
          if (state?.status && state.status !== statuses[statuses.length - 1]) statuses.push(state.status);
          finalState = state;
          const currentNotices = await lyricsWin.evaluate(() =>
            Array.from(document.querySelectorAll('.notice span')).map((node) => node.textContent.trim()),
          );
          for (const text of currentNotices) if (!notices.includes(text)) notices.push(text);
          if (!claimed) {
            claimed = await lyricsWin.evaluate((p) => window.__qingyinTest.readLyrics(p), trackPath);
          }
          if (state?.status === 'done' && claimed && notices.some((n) => /歌词扫描：新认领 \d+/.test(n))) break;
          await sleep(200);
        }
        facts.lyricsStatusSeq = statuses;
        facts.lyricsNotices = notices;
        facts.lyricsClaimed = claimed
          ? { source: claimed.source, lyricPath: claimed.lyricPath, textLength: String(claimed.text ?? '').length }
          : null;
        check(statuses.includes('running') && statuses.includes('done'), '状态序列包含 running → done', { statuses });
        check(finalState?.status === 'done' && finalState?.exitCode === 0, '终态 done（exit 0）', {
          status: finalState?.status,
          exitCode: finalState?.exitCode,
        });

        const lrcPath = path.join(LYRICS_MUSIC_DIR, 'sample-cn.lrc');
        const lrcText = fs.existsSync(lrcPath) ? fs.readFileSync(lrcPath, 'utf8') : '';
        check(lrcText.includes('假工具第一句'), '假工具真的往曲库写了 .lrc（磁盘上可读）', {
          lrcPath: path.relative(repoRoot, lrcPath),
          bytes: lrcText.length,
        });

        check(Boolean(claimed), '渲染进程自动认领了工具写出的歌词（rescanLyrics 生效）', facts.lyricsClaimed);
        check(
          Boolean(claimed && String(claimed.text ?? '').includes('假工具第一句')),
          '认领记录里就是假工具写的内容',
          facts.lyricsClaimed,
        );

        const scanNotice = notices.map((text) => /歌词扫描：新认领 (\d+)/.exec(text)).find(Boolean);
        facts.lyricsScanNotice = scanNotice ? scanNotice[0] : null;
        check(Boolean(scanNotice) && Number(scanNotice[1]) >= 1, 'UI 报出「新认领 N 首」（N≥1）', {
          notice: scanNotice?.[0] ?? null,
        });
        check(notices.some((text) => text.includes('补歌词完成')), 'UI 报出「补歌词完成，已重新扫描歌词」', {
          notices,
        });

        // 歌词面板能看到内容
        await lyricsWin.keyboard.press('y');
        await lyricsWin.waitForSelector('.drawer .lyric-line', { timeout: 15000 });
        const panel = await lyricsWin.evaluate(() => ({
          lines: Array.from(document.querySelectorAll('.drawer .lyric-line')).map((node) => node.textContent.trim()),
          text: document.querySelector('.drawer')?.innerText ?? '',
        }));
        facts.lyricsPanel = panel;
        check(panel.lines.length >= 3, '歌词面板有 3 行（假工具写的）', { lines: panel.lines });
        check(panel.text.includes('假工具第一句'), '歌词面板正文里能看到假工具第一句', {
          first: panel.lines[0] ?? null,
        });

        // 第一不变式：补歌词 + 自动重扫全程没打断播放
        const stillPlaying = await lyricsWin.evaluate(() => ({
          paused: window.__qingyinTest.paused(),
          playing: window.__qingyinTest.state().playing,
        }));
        facts.musicStillPlayingAfterFill = stillPlaying;
        check(stillPlaying.paused === false && stillPlaying.playing === true, '补歌词 + 自动重扫全程音乐没停（第一不变式）', stillPlaying);

        await lyricsWin.screenshot({ path: path.join(artifactsDir, 'verify-lyrics-fill.png') });
        check(lyricsErrors.length === 0, '补歌词会话零渲染进程报错', { errors: lyricsErrors.slice(0, 3) });
      } finally {
        dialogDriver?.kill();
        const code = await quitApp(lyricsApp);
        facts.lyricsQuitExit = code;
        check(code === 0, '补歌词会话正常退出（exit 0）', { exitCode: code });
      }
    });

    // ---------- 8a) 补歌词 · 工具路径不存在 ----------
    // t9 语义（desktop/lyricsIpc.js 的 resolveLyricsToolScript）：自定义路径
    // 不存在 → **快速失败**，绝不静默回退到内置 fill-lyrics.ps1（回退 = 假成功，
    // 用户以为自己那个工具跑了；内置若再失败，报错还张冠李戴）。
    // 证据：failed + 错误文案含路径；startedAt 保持 null、日志尾为空 =
    // 没有任何进程被启动过（没有回退去跑内置）。
    await session('8a) 补歌词 · 工具路径不存在 → 快速失败（绝不静默回退内置）', async () => {
      const missingTool = path.join(artifactsDir, 'this-lyrics-tool-does-not-exist.ps1');
      writeSettingsFile(LYRICS_USER_DATA_DIR, {
        openAtLogin: false,
        lyricsToolPath: missingTool,
        musicFolderPath: LYRICS_MUSIC_DIR,
      });
      const { app: failApp, win: failWin, errors: failErrors } = await launchWithRetry(
        LYRICS_USER_DATA_DIR,
        'lyrics-missing-tool',
        logMain,
      );
      try {
        await failWin.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
        await failWin.waitForSelector('.row, .empty', { timeout: 60000 });

        const trigger = await failApp.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
        const final = await waitForLyricsState(failApp, 'failed', 30000);
        facts.lyricsMissingTool = {
          trigger: { ok: trigger.ok, reason: trigger.reason, scriptPath: trigger.scriptPath, status: trigger.status?.status },
          final: {
            status: final?.status,
            exitCode: final?.exitCode,
            startedAt: final?.startedAt,
            scriptLabel: final?.scriptLabel,
            error: final?.error,
            tail: final?.tail?.slice(-3) ?? [],
          },
        };
        check(trigger.ok === false && trigger.reason === 'tool-script-missing', '触发即拒绝：ok:false + tool-script-missing', {
          ok: trigger.ok,
          reason: trigger.reason,
        });
        check(final?.status === 'failed', '终态 failed（预检失败也走状态机，UI 看得到）', { status: final?.status });
        check(
          typeof final?.error === 'string' && final.error.includes(missingTool),
          '错误文案包含失效路径本身 + 怎么改',
          { error: final?.error ?? null },
        );
        check(
          final?.startedAt === null && (final?.tail ?? []).length === 0,
          '没有任何进程被启动（startedAt=null 且日志尾为空 = 没有回退去跑内置）',
          { startedAt: final?.startedAt ?? null, tail: final?.tail ?? [] },
        );
        check(failErrors.length === 0, '失败路径会话零渲染进程报错', { errors: failErrors.slice(0, 3) });
      } finally {
        const code = await quitApp(failApp);
        facts.lyricsMissingToolExit = code;
        check(code === 0, '失败路径会话正常退出（exit 0）', { exitCode: code });
      }
    });

    // ---------- 8b) 补歌词 · 工具内部失败（exit 5） ----------
    await session('8b) 补歌词 · 工具内部失败 → failed + 可读错误 + UI 提示', async () => {
      const brokenTool = generateBrokenTool();
      writeSettingsFile(LYRICS_USER_DATA_DIR, {
        openAtLogin: false,
        lyricsToolPath: brokenTool,
        musicFolderPath: LYRICS_MUSIC_DIR,
      });
      const { app: brokenApp, win: brokenWin, errors: brokenErrors } = await launchWithRetry(
        LYRICS_USER_DATA_DIR,
        'lyrics-broken-tool',
        logMain,
      );
      try {
        await brokenWin.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
        await brokenWin.waitForSelector('.row, .empty', { timeout: 60000 });

        const trigger = await brokenApp.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
        let final = null;
        let failNotice = null;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          final = await brokenApp.evaluate(() => globalThis.__qingyinDesktopShell.lyricsState());
          if (!failNotice) {
            const texts = await brokenWin.evaluate(() =>
              Array.from(document.querySelectorAll('.notice span')).map((node) => node.textContent.trim()),
            );
            failNotice = texts.find((text) => text.includes('补歌词失败')) ?? null;
          }
          if (final?.status === 'failed' && failNotice) break;
          await sleep(200);
        }
        facts.lyricsBrokenTool = {
          trigger: { ok: trigger.ok, scriptPath: trigger.scriptPath },
          final: { status: final?.status, exitCode: final?.exitCode, tail: final?.tail?.slice(-3) ?? [] },
          failNotice,
        };
        check(
          trigger.ok === true &&
            typeof trigger.scriptPath === 'string' &&
            trigger.scriptPath.endsWith('verify-broken-lyrics-tool.ps1'),
          '用上了指定的失败工具（没有回退）',
          { scriptPath: trigger.scriptPath },
        );
        check(final?.status === 'failed' && final?.exitCode === 5, '终态 failed + 工具退出码 5', {
          status: final?.status,
          exitCode: final?.exitCode,
        });
        check(
          (final?.tail ?? []).some((line) => line.includes('VERIFY-FAIL-TOOL')),
          '工具的可读错误进了日志尾',
          { tail: final?.tail?.slice(-2) ?? [] },
        );
        check(Boolean(failNotice), 'UI 弹出「补歌词失败」提示（不是静默成功）', { notice: failNotice });
        check(brokenErrors.length === 0, '工具失败会话零渲染进程报错', { errors: brokenErrors.slice(0, 3) });
      } finally {
        const code = await quitApp(brokenApp);
        facts.lyricsBrokenToolExit = code;
        check(code === 0, '工具失败会话正常退出（exit 0）', { exitCode: code });
      }
    });

    // ---------- 9) 补歌词 · 取消（慢工具） ----------
    await session('9) 补歌词 · 取消（慢工具）→ cancelled + 进程树杀干净', async () => {
      prepareLyricsMusicFolder(); // 清掉上一幕写的 .lrc，让"取消没写文件"可证
      const slowTool = generateSlowTool();
      writeSettingsFile(LYRICS_USER_DATA_DIR, {
        openAtLogin: false,
        lyricsToolPath: slowTool,
        musicFolderPath: LYRICS_MUSIC_DIR,
      });
      const { app: cancelApp, win: cancelWin, errors: cancelErrors } = await launchWithRetry(
        LYRICS_USER_DATA_DIR,
        'lyrics-cancel',
        logMain,
      );
      try {
        await cancelWin.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
        await cancelWin.waitForSelector('.row, .empty', { timeout: 60000 });

        const trigger = await cancelApp.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
        const running = await waitForLyricsState(cancelApp, 'running', 20000);
        check(trigger.ok === true && running?.status === 'running', '慢工具进入 running', {
          status: running?.status,
        });

        // 渲染进程侧取消（preload 暴露的 IPC 通道，不是主进程直调）
        const cancelResult = await cancelWin.evaluate(() => window.qingyinDesktop.lyrics.cancel());
        const final = await waitForLyricsState(cancelApp, 'cancelled', 20000);
        facts.lyricsCancel = {
          ipc: cancelResult,
          final: { status: final?.status, error: final?.error, finishedAt: final?.finishedAt ?? null },
        };
        check(cancelResult?.cancelled === true, '渲染进程 IPC cancel 返回 cancelled=true', {
          cancelled: cancelResult?.cancelled,
        });
        check(final?.status === 'cancelled', '终态 cancelled（独立终态，不是 failed）', {
          status: final?.status,
        });
        check(final?.error == null, 'cancelled 不带失败语义（error=null）', { error: final?.error ?? null });
        check(final?.finishedAt != null, 'cancelled 有 finishedAt', { finishedAt: final?.finishedAt ?? null });

        const statusLine = await cancelWin.evaluate(
          () => document.querySelector('.lyrics-tool-status')?.textContent ?? null,
        );
        check(statusLine == null || !statusLine.includes('失败'), '面板状态行不把取消显示成失败', { statusLine });

        const menuLabel = await waitFor(
          async () => {
            const state = await cancelApp.evaluate(() => globalThis.__qingyinDesktopShell.readState());
            return menuItemOf(state, 'fill-lyrics')?.label === '补歌词…（上次已取消）' ? '补歌词…（上次已取消）' : null;
          },
          10000,
        );
        check(menuLabel === '补歌词…（上次已取消）', '托盘菜单反映「上次已取消」（状态推送到了主进程）', {
          menuLabel,
        });

        const cancelNotice = await waitFor(
          async () => {
            const texts = await cancelWin.evaluate(() =>
              Array.from(document.querySelectorAll('.notice span')).map((node) => node.textContent.trim()),
            );
            return texts.find((text) => text.includes('已取消补歌词')) ?? null;
          },
          10000,
        );
        check(Boolean(cancelNotice), 'UI 报出「已取消补歌词」', { cancelNotice });

        // 杀树证据：慢脚本拉起的子进程命令行带 marker，取消后一个都不许活着
        const survivors = await countProcessTree(SLOW_MARKER);
        facts.lyricsCancelTreeSurvivors = survivors;
        check(survivors === 0, '取消后慢工具进程树 0 残留', { survivors });
        check(
          !fs.existsSync(path.join(LYRICS_MUSIC_DIR, 'sample-cn.lrc')),
          '取消后没有写出 .lrc（曲库目录是清空后重建的）',
        );
        check(cancelErrors.length === 0, '取消会话零渲染进程报错', { errors: cancelErrors.slice(0, 3) });
      } finally {
        const code = await quitApp(cancelApp);
        facts.lyricsCancelExit = code;
        check(code === 0, '取消会话正常退出（exit 0）', { exitCode: code });
      }
    });

    // ---------- 10) 窗口状态记忆 ----------
    await session('10) 窗口状态记忆（记住/恢复/最大化/屏幕外回退）', async () => {
      cleanDir(WINDOW_USER_DATA_DIR);
      const launchWindow = (tag) => launchWithRetry(WINDOW_USER_DATA_DIR, tag, logMain);

      // run1：首次启动 → 改几何（写盘）→ 最大化 → 退出（存档不丢）
      {
        const { app: windowApp } = await launchWindow('win1');
        try {
          const startup = await windowApp.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
          facts.windowRun1Startup = startup;
          check(startup.saved === null && startup.source === 'default', '首次启动：无存档，几何来源 default', {
            saved: startup.saved,
            source: startup.source,
          });
          const geometry = await readGeometry(windowApp);
          facts.windowDisplays = geometry.displays;
          check(
            geometry.visible && isOnDisplays(geometry.bounds, geometry.displays, MIN_VISIBLE_PX),
            '首启窗口可见且落在屏幕工作区里',
            geometry.bounds,
          );

          const primary =
            geometry.displays.find((display) => display.workArea.x === 0 && display.workArea.y === 0) ??
            geometry.displays[0];
          const target = {
            x: primary.workArea.x + 60,
            y: primary.workArea.y + 40,
            // 不能小于 createMainWindow 的 minWidth/minHeight，否则 Electron 会夹一次
            width: Math.max(900, Math.min(1180, primary.workArea.width - 120)),
            height: Math.max(600, Math.min(760, primary.workArea.height - 120)),
          };
          facts.windowRun1Target = target;
          await windowApp.evaluate(
            ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
            target,
          );
          await sleep(1600); // 防抖 600ms + 余量
          const onDisk = readSettingsFromDisk(WINDOW_USER_DATA_DIR);
          facts.windowRun1AfterResize = onDisk.windowState;
          check(closeEnough(onDisk.windowState, target), '改几何后 settings.json 里真的写下了这个几何', {
            saved: onDisk.windowState,
            target,
          });
          const stats = await windowApp.evaluate(
            () => globalThis.__qingyinDesktopShell.readWindowState().saveStats,
          );
          check(stats?.writes >= 1, '写盘计数 ≥1（不是只有内存里的值）', stats);

          await windowApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
          await sleep(1600);
          const maximized = await readGeometry(windowApp);
          const diskMax = readSettingsFromDisk(WINDOW_USER_DATA_DIR);
          facts.windowRun1AfterMaximize = { saved: diskMax.windowState, screen: maximized.bounds };
          check(diskMax.windowState?.maximized === true, '最大化后存档 maximized=true', diskMax.windowState);
          check(
            diskMax.windowState?.width !== maximized.bounds.width ||
              diskMax.windowState?.height !== maximized.bounds.height,
            '存档存的是 getNormalBounds（不是整块屏幕的尺寸）',
            facts.windowRun1AfterMaximize,
          );

          const exit = await quitApp(windowApp);
          facts.windowRun1Exit = exit;
          check(exit === 0, 'run1 托盘退出 exit 0', { exitCode: exit });
          const afterQuit = readSettingsFromDisk(WINDOW_USER_DATA_DIR);
          facts.windowSavedNormal = afterQuit.windowState;
          check(afterQuit.windowState?.maximized === true, '真退出后最大化状态仍在（退出落盘没丢）', {
            saved: afterQuit.windowState,
          });
        } finally {
          try {
            await windowApp.close();
          } catch {
            // 已经自己退出
          }
        }
      }

      // run2：重启 → 恢复最大化 → 还原回存档的普通几何 → 换新几何 → 退出
      {
        const { app: windowApp } = await launchWindow('win2');
        try {
          const startup = await windowApp.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
          facts.windowRun2Startup = startup;
          check(startup.source === 'saved', '重启后几何来源 saved（沿用上次存档）', {
            source: startup.source,
            reason: startup.reason,
          });
          check(startup.maximized === true, '重启后按存档恢复最大化状态', { maximized: startup.maximized });
          await sleep(1000);
          const geometry = await readGeometry(windowApp);
          check(geometry.maximized === true, '窗口真的是最大化状态（isMaximized）', {
            maximized: geometry.maximized,
          });

          const expected = facts.windowSavedNormal;
          await windowApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
          await sleep(1000);
          const restored = await readGeometry(windowApp);
          facts.windowRun2Restored = restored.bounds;
          check(closeEnough(restored.bounds, expected, 40), '还原后回到存档里的位置与尺寸（容差 40px）', {
            restored: restored.bounds,
            expected,
          });

          const primary =
            geometry.displays.find((display) => display.workArea.x === 0 && display.workArea.y === 0) ??
            geometry.displays[0];
          const next = {
            x: primary.workArea.x + 220,
            y: primary.workArea.y + 160,
            width: Math.max(900, Math.min(1024, primary.workArea.width - 240)),
            height: Math.max(600, Math.min(700, primary.workArea.height - 240)),
          };
          facts.windowRun2Target = next;
          await windowApp.evaluate(
            ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
            next,
          );
          await sleep(1600);
          const onDisk = readSettingsFromDisk(WINDOW_USER_DATA_DIR);
          check(closeEnough(onDisk.windowState, next), '换新几何后 settings.json 更新', {
            saved: onDisk.windowState,
            next,
          });
          check(onDisk.windowState?.maximized === false, '还原后存档 maximized=false', onDisk.windowState);

          const exit = await quitApp(windowApp);
          facts.windowRun2Exit = exit;
          check(exit === 0, 'run2 exit 0', { exitCode: exit });
          facts.windowSavedNormal2 = readSettingsFromDisk(WINDOW_USER_DATA_DIR).windowState;
        } finally {
          try {
            await windowApp.close();
          } catch {
            // 已经自己退出
          }
        }
      }

      // run3：存档在"被拔掉的副屏"上（x=3000）→ 必须回到屏幕内
      writeWindowStateToSettings(WINDOW_USER_DATA_DIR, {
        x: 3000,
        y: 200,
        width: 1000,
        height: 700,
        maximized: false,
      });
      {
        const { app: windowApp } = await launchWindow('win3');
        try {
          const startup = await windowApp.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
          const geometry = await readGeometry(windowApp);
          facts.windowRun3 = { startup, geometry: geometry.bounds, displayCount: geometry.displays.length };
          if (geometry.displays.length === 1) {
            check(startup.source === 'default', '存档在副屏（x=3000）且本机只有一块屏 → 回退 default', {
              source: startup.source,
            });
            check(/不在任何屏幕/.test(startup.reason ?? ''), 'reason 说明了为什么回退', {
              reason: startup.reason,
            });
          } else {
            check(startup.source === 'saved', '本机真有副屏且坐标有效 → 沿用存档', { source: startup.source });
          }
          check(
            geometry.visible && isOnDisplays(geometry.bounds, geometry.displays, MIN_VISIBLE_PX),
            '窗口可见且在屏幕工作区内（不是"打开了但看不见"）',
            geometry.bounds,
          );

          const exit = await quitApp(windowApp);
          facts.windowRun3Exit = exit;
          check(exit === 0, 'run3 exit 0', { exitCode: exit });
          const onDisk = readSettingsFromDisk(WINDOW_USER_DATA_DIR);
          facts.windowRun3Saved = onDisk.windowState;
          check(
            isOnDisplays(onDisk.windowState, geometry.displays, MIN_VISIBLE_PX),
            '退出写回的是屏幕内几何（下次启动不会再回退）',
            onDisk.windowState,
          );
        } finally {
          try {
            await windowApp.close();
          } catch {
            // 已经自己退出
          }
        }
      }

      // run4：存档是 x=99999（脏坐标，sanitize 直接丢）→ 仍在屏幕内
      writeWindowStateToSettings(WINDOW_USER_DATA_DIR, {
        x: 99999,
        y: 40,
        width: 1000,
        height: 700,
        maximized: false,
      });
      {
        const { app: windowApp } = await launchWindow('win4');
        try {
          const startup = await windowApp.evaluate(() => globalThis.__qingyinDesktopShell.readWindowState());
          const geometry = await readGeometry(windowApp);
          facts.windowRun4 = { startup, geometry: geometry.bounds };
          check(startup.saved === null && startup.source === 'default', 'x=99999 这类脏坐标被丢弃 → 用默认几何', {
            saved: startup.saved,
            source: startup.source,
          });
          check(
            geometry.visible && isOnDisplays(geometry.bounds, geometry.displays, MIN_VISIBLE_PX),
            '窗口出现在屏幕内，坐标不是 99999',
            geometry.bounds,
          );

          const exit = await quitApp(windowApp);
          facts.windowRun4Exit = exit;
          check(exit === 0, 'run4 exit 0', { exitCode: exit });
          const onDisk = readSettingsFromDisk(WINDOW_USER_DATA_DIR);
          check(
            onDisk.windowState && isOnDisplays(onDisk.windowState, geometry.displays, MIN_VISIBLE_PX),
            '退出后存档是屏幕内几何（没有把脏坐标写回去）',
            onDisk.windowState,
          );
        } finally {
          try {
            await windowApp.close();
          } catch {
            // 已经自己退出
          }
        }
      }
    });

    facts.durationMs = Date.now() - t0;
  } catch (error) {
    problems.push(`验证中止：${errorText(error)}`);
    console.error(`\n验证中止：${errorText(error)}`);
  } finally {
    // t7：报告里明确分开「沿用上一期」与「本期新增」，便于核对有没有退化
    const inheritedAssertions = assertions.filter((item) => item.group === 'inherited');
    const addedAssertions = assertions.filter((item) => item.group === 'added');
    const summarize = (list) => ({
      total: list.length,
      passed: list.filter((item) => item.ok).length,
      failed: list.filter((item) => !item.ok).map((item) => item.label),
    });
    const assertionSummary = {
      inherited: summarize(inheritedAssertions),
      added: summarize(addedAssertions),
    };

    const report = {
      ok: problems.length === 0,
      problems,
      warnings,
      assertionSummary,
      assertions: {
        inherited: inheritedAssertions,
        added: addedAssertions,
      },
      facts,
      consoleErrors,
      mainLog: mainLog.slice(0, 400),
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('\n== 断言清单 ==');
    console.log(
      `  沿用上一期（t3）：${assertionSummary.inherited.total} 条，通过 ${assertionSummary.inherited.passed}` +
        `　|　本期新增（t7）：${assertionSummary.added.total} 条，通过 ${assertionSummary.added.passed}`,
    );
    if (assertionSummary.inherited.failed.length > 0) {
      console.log('  沿用项失败：');
      for (const label of assertionSummary.inherited.failed) console.log(`    - ${label}`);
    }
    if (assertionSummary.added.failed.length > 0) {
      console.log('  新增项失败：');
      for (const label of assertionSummary.added.failed) console.log(`    - ${label}`);
    }

    console.log('\n== 汇总 ==');
    if (problems.length === 0) {
      console.log(
        `✔ 桌面端验收全部通过：沿用上一期 ${assertionSummary.inherited.total} 条 + 本期新增 ${assertionSummary.added.total} 条`,
      );
      console.log('  （四条硬指标未退化；补歌词成功/失败/取消、托盘播放控制、窗口状态记忆均验证）');
      if (warnings.length > 0) {
        console.log(`⚠ ${warnings.length} 条警告：`);
        for (const warning of warnings) console.log(`  - ${warning}`);
      }
    } else {
      console.log(`✖ 失败 ${problems.length} 项：`);
      for (const problem of problems) console.log(`  - ${problem}`);
      if (warnings.length > 0) {
        console.log(`⚠ 另有 ${warnings.length} 条警告：`);
        for (const warning of warnings) console.log(`  - ${warning}`);
      }
    }
    console.log(`报告: ${path.relative(repoRoot, REPORT_PATH)}`);

    try {
      await app.close();
    } catch {
      // 第 5 步里进程已经自己退出时会抛，预期内
    }
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error('verify.mjs 崩了：');
  console.error(error);
  process.exitCode = 1;
});
