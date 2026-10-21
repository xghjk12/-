import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pw from 'playwright-core';
import electronPath from 'electron';

/**
 * t3 验收：用 Playwright 驱动**真正的桌面端入口**（desktop/main.js），只验四条硬指标。
 *
 *   1. 窗口能开，曲库列表有行（等布局稳定后再数，不是量首帧空 DOM）
 *   2. 双击一首歌**真的开始播**（audio 元素的 currentTime 在走，不是只有界面状态）
 *   3. 歌词面板能打开、有歌词行（双击带 plain.lrc 的 plain.mp3，期望 3 行）
 *   4. **隐藏窗口后音乐继续**（本任务唯一不可替代的卖点）：
 *      走托盘「隐藏窗口」调用的同一个函数 win.hide()，等 3 秒，逐 150ms 采样
 *      currentTime —— 窗口不可见期间音频仍在前进/自动切歌，才算通过。
 *
 * 另外附带两件 t2 已验证、这里顺带复验的事（不参与 t3 四条判定，但会报告）：
 *   - 隐藏后托盘菜单文案翻成「显示窗口」；再显示回来后仍在播
 *   - 托盘「退出」→ 进程 exit 0、53140 端口释放
 *
 * 用法（仓库根目录，先 pnpm build）：
 *   node desktop/verify.mjs
 *
 * 每次运行使用独立 profile（artifacts/desktop/userdata-verify），不碰用户真实曲库；
 * 启动前会清空它，所以每次都是干净的 4 首内置样本。
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

  /** 断言：立即打印，失败记进 problems（不中断）。 */
  function check(condition, label, evidence) {
    const ok = Boolean(condition);
    console.log(`  ${ok ? '✔' : '✖'} ${label}${evidence !== undefined ? ` — ${JSON.stringify(evidence)}` : ''}`);
    if (!ok) problems.push(label);
    return ok;
  }

  /** 一个阶段：抛异常时留下现场诊断，并把失败记进 problems。 */
  async function stage(name, fn) {
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

    // ---------- 附加：托盘「退出」= 真退出（t2 覆盖，这里顺带复验） ----------
    await stage('5) 附加：托盘「退出」', async () => {
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

    facts.durationMs = Date.now() - t0;
  } catch (error) {
    problems.push(`验证中止：${errorText(error)}`);
    console.error(`\n验证中止：${errorText(error)}`);
  } finally {
    const report = {
      ok: problems.length === 0,
      problems,
      warnings,
      facts,
      consoleErrors,
      mainLog: mainLog.slice(0, 200),
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('\n== 汇总 ==');
    if (problems.length === 0) {
      console.log('✔ t3 四条全部通过：窗口+列表 / 真实播放 / 歌词面板 / 隐藏后继续播');
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
