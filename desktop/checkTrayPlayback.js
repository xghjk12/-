'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * t6 验收之一：托盘播放控制（**窗口隐藏时**照样有效）。
 *
 * 全部走真实路径，不抄近路：
 *   0. 干净 profile 启动（--user-data-dir，不碰用户真实曲库）
 *   1. 曲库为空时：托盘三项存在但**禁用**（没有当前曲目可控制）
 *   2. 导入内置样本（4 首）→ 双击第一行真的开始播 → 三项变可用、文案是「暂停」
 *   3. 隐藏窗口 → 断言窗口不可见但进程/渲染进程还活着、还在播（进度在走）
 *   4. **隐藏状态下**依次发 play-pause / play-pause / next / prev，
 *      每一步都断言渲染进程里的真实事实：
 *        - `audio.paused`（`__qingyinTest.paused()`）
 *        - 当前曲目下标（`__qingyinTest.state().currentIndex`）
 *        - 托盘菜单文案跟着状态换向（`readState().menu` 里 play-pause 的 label）
 *      命令走 `__qingyinDesktopShell.playbackCommand(type)`——那正是托盘菜单项
 *      click 时调用的同一个函数，所以验的是菜单那条路径，不是另开一条后门。
 *   5. 显示窗口 → 状态与菜单仍然一致（隐藏期间没有把状态搞坏）
 *   6. 托盘「退出」→ 进程 exit 0
 *
 * 用法（仓库根目录，先 pnpm build）：
 *   node desktop/checkTrayPlayback.js
 *
 * 产物：artifacts/desktop/tray-playback-check.json + 截图
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const ORIGIN = 'http://127.0.0.1:53140';
const userDataDir = path.join(artifactsDir, 'userdata-playback-check');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等一个条件成立（轮询），超时返回最后一次的值——不把失败藏起来。 */
async function waitFor(fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return last;
    await sleep(intervalMs);
  }
}

/** 从 readState().menu 里挑出某一项。 */
function menuItem(state, id) {
  return (state?.menu ?? []).find((item) => item.id === id) ?? null;
}

async function main() {
  const env = { ...process.env };
  // 坑 1：DSH 终端会把 ELECTRON_RUN_AS_NODE 传给子进程，带着它 electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;
  const launchArgs = [desktopDir, '--no-sandbox', `--user-data-dir=${userDataDir}`];

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
    await sleep(1000); // 等 boot() 走完、渲染侧订阅装上并发出首次状态上报

    // ---------- 1. 空曲库：三项存在但禁用 ----------
    console.log('\n== 1) 曲库为空时，托盘三项存在但禁用 ==');
    const stateEmpty = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    facts.menuEmptyLibrary = stateEmpty.menu;
    const ids = (stateEmpty.menu ?? []).map((item) => item.id).filter(Boolean);
    for (const required of ['play-pause', 'prev', 'next']) {
      check(ids.includes(required), `托盘菜单里有「${required}」`, { ids });
    }
    const emptyPlay = menuItem(stateEmpty, 'play-pause');
    check(emptyPlay?.label === '播放', '没有播放时文案是「播放」', { label: emptyPlay?.label });
    check(emptyPlay?.enabled === false, '没有当前曲目 → play-pause 禁用', { enabled: emptyPlay?.enabled });
    check(menuItem(stateEmpty, 'prev')?.enabled === false, '没有当前曲目 → prev 禁用');
    check(menuItem(stateEmpty, 'next')?.enabled === false, '没有当前曲目 → next 禁用');
    facts.statusEmpty = await app.evaluate(() => globalThis.__qingyinDesktopShell.readPlaybackStatus());
    check(facts.statusEmpty.hasTrack === false, '主进程侧状态：hasTrack=false（渲染进程上报的，不是猜的）', facts.statusEmpty);

    // ---------- 2. 导入样本并开始播放 ----------
    console.log('\n== 2) 导入内置样本并开始播放 ==');
    const trackCount = await win.evaluate(() => window.__qingyinTest.loadFixtureLibrary());
    check(trackCount === 4, '内置样本导入（4 首）', { trackCount });
    await win.waitForSelector('.row', { timeout: 60000 });
    await win.locator('.row').first().dblclick({ timeout: 15000 });

    const started = await waitFor(async () => {
      const paused = await win.evaluate(() => window.__qingyinTest.paused());
      return paused === false ? { paused } : null;
    }, 20000);
    check(Boolean(started), '双击第一行后真的开始播放（audio.paused=false）', started);

    const statePlaying = await waitFor(async () => {
      const state = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
      return menuItem(state, 'play-pause')?.label === '暂停' ? state : null;
    }, 10000);
    facts.menuWhilePlaying = statePlaying?.menu ?? null;
    check(Boolean(statePlaying), '托盘文案随播放状态换成「暂停」（状态由渲染进程上报）');
    check(menuItem(statePlaying, 'play-pause')?.enabled === true, '有当前曲目 → play-pause 可用');
    check(menuItem(statePlaying, 'next')?.enabled === true, '有当前曲目 → next 可用');
    facts.statusPlaying = await app.evaluate(() => globalThis.__qingyinDesktopShell.readPlaybackStatus());
    check(
      facts.statusPlaying?.playing === true && facts.statusPlaying?.hasTrack === true,
      '主进程侧状态：playing=true / hasTrack=true',
      facts.statusPlaying,
    );
    const indexBefore = facts.statusPlaying?.currentIndex ?? null;
    check(Number.isInteger(indexBefore) && indexBefore >= 0, '当前曲目下标可用', { indexBefore });

    // ---------- 3. 隐藏窗口，确认还在放 ----------
    console.log('\n== 3) 隐藏窗口（不销毁）后仍在播放 ==');
    await app.evaluate(() => globalThis.__qingyinDesktopShell.hideMainWindow());
    await sleep(500);
    const hidden = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    check(hidden.windowVisible === false && hidden.windowExists === true, '窗口已隐藏但仍存在（渲染进程没被销毁）', {
      windowVisible: hidden.windowVisible,
      windowExists: hidden.windowExists,
    });
    check(hidden.menu.find((item) => item.id === 'toggle-window')?.label === '显示窗口', '菜单文案换成「显示窗口」');
    const posHidden1 = await win.evaluate(() => window.__qingyinTest.positionSec());
    await sleep(1200);
    const posHidden2 = await win.evaluate(() => window.__qingyinTest.positionSec());
    check(posHidden2 > posHidden1, '隐藏期间进度仍在走（还在放歌）', { posHidden1, posHidden2 });
    check((await win.evaluate(() => window.__qingyinTest.paused())) === false, '隐藏期间 audio.paused=false');

    // ---------- 4. 隐藏状态下的托盘播放控制 ----------
    console.log('\n== 4) 隐藏状态下用托盘命令控制播放 ==');

    const send = async (type) => {
      const result = await app.evaluate((commandType) => globalThis.__qingyinDesktopShell.playbackCommand(commandType), type);
      check(result?.ok === true, `托盘命令已送达渲染进程：${type}`, result);
      return result;
    };
    const pausedNow = () => win.evaluate(() => window.__qingyinTest.paused());
    const statusNow = () => app.evaluate(() => globalThis.__qingyinDesktopShell.readPlaybackStatus());
    const labelNow = async () => {
      const state = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
      return menuItem(state, 'play-pause')?.label ?? null;
    };
    const stillHidden = async () => {
      const state = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
      return state.windowVisible === false && state.windowExists === true;
    };

    // 4a. 暂停
    await send('play-pause');
    const pausedAfter = await waitFor(async () => ((await pausedNow()) === true ? true : null), 8000);
    check(Boolean(pausedAfter), '窗口隐藏时点「暂停」→ audio.paused 变 true', { paused: await pausedNow() });
    const labelAfterPause = await waitFor(async () => ((await labelNow()) === '播放' ? '播放' : null), 8000);
    check(labelAfterPause === '播放', '暂停后托盘文案换回「播放」', { label: await labelNow() });
    facts.statusAfterPause = await statusNow();
    check(facts.statusAfterPause?.playing === false, '主进程侧状态：playing=false', facts.statusAfterPause);
    check(await stillHidden(), '整个过程窗口一直是隐藏的（命令不需要窗口可见）');
    await win.screenshot({ path: path.join(artifactsDir, 'tray-playback-paused.png') }).catch(() => {});

    // 4b. 播放
    await send('play-pause');
    const resumedAfter = await waitFor(async () => ((await pausedNow()) === false ? true : null), 8000);
    check(Boolean(resumedAfter), '窗口隐藏时点「播放」→ audio.paused 变 false', { paused: await pausedNow() });
    const labelAfterPlay = await waitFor(async () => ((await labelNow()) === '暂停' ? '暂停' : null), 8000);
    check(labelAfterPlay === '暂停', '播放后托盘文案变「暂停」', { label: await labelNow() });

    // 4c. 下一首
    const indexBeforeNext = (await statusNow())?.currentIndex;
    await send('next');
    const indexAfterNext = await waitFor(
      async () => {
        const index = (await statusNow())?.currentIndex;
        return index !== indexBeforeNext ? index : null;
      },
      15000,
    );
    facts.next = { indexBeforeNext, indexAfterNext };
    check(
      Number.isInteger(indexAfterNext) && indexAfterNext !== indexBeforeNext,
      '窗口隐藏时点「下一首」→ 当前曲目下标前进',
      facts.next,
    );
    const rendererIndex = await win.evaluate(() => window.__qingyinTest.state().currentIndex);
    check(rendererIndex === indexAfterNext, '主进程记的下标与渲染进程 store 里的下标一致', {
      rendererIndex,
      mainIndex: indexAfterNext,
    });
    check((await pausedNow()) === false, '切歌后仍在播放（audio.paused=false）');

    // 4d. 上一首
    await send('prev');
    const indexAfterPrev = await waitFor(
      async () => {
        const index = (await statusNow())?.currentIndex;
        return index !== indexAfterNext ? index : null;
      },
      15000,
    );
    facts.prev = { indexAfterNext, indexAfterPrev };
    check(
      Number.isInteger(indexAfterPrev) && indexAfterPrev !== indexAfterNext,
      '窗口隐藏时点「上一首」→ 当前曲目下标回退',
      facts.prev,
    );
    check(indexAfterPrev === indexBeforeNext, '上一首之后回到切歌前的那首', facts.prev);

    // 4e. 非法命令必须被挡住（白名单在主进程侧）
    const bogus = await app.evaluate(() => globalThis.__qingyinDesktopShell.playbackCommand('quit'));
    check(bogus?.ok === false, '非白名单命令被主进程拒绝（不会把 quit 之类当播放命令发出去）', bogus);

    // ---------- 5. 重新显示窗口 ----------
    console.log('\n== 5) 重新显示窗口，状态依旧一致 ==');
    await app.evaluate(() => globalThis.__qingyinDesktopShell.showMainWindow());
    await sleep(600);
    const shown = await app.evaluate(() => globalThis.__qingyinDesktopShell.readState());
    check(shown.windowVisible === true, '窗口重新可见');
    check(shown.menu.find((item) => item.id === 'toggle-window')?.label === '隐藏窗口', '菜单文案换回「隐藏窗口」');
    check((await pausedNow()) === false, '显示回来后仍在播放');

    // ---------- 6. 退出 ----------
    console.log('\n== 6) 托盘「退出」==');
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
  } finally {
    const report = {
      ok: problems.length === 0,
      problems,
      facts,
      mainLog: mainLog.slice(0, 120),
      consoleErrors,
    };
    fs.writeFileSync(
      path.join(artifactsDir, 'tray-playback-check.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    console.log('\n== 汇总 ==');
    if (problems.length === 0) {
      console.log('✔ 托盘播放控制全部通过（含窗口隐藏时的三条命令）');
    } else {
      console.log(`✖ 失败 ${problems.length} 项:`);
      for (const problem of problems) console.log(`  - ${problem}`);
    }
    console.log('报告: artifacts/desktop/tray-playback-check.json');
    try {
      await app.close();
    } catch {
      // 进程已经自己退出（第 6 步）时会抛——预期内
    }
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error('checkTrayPlayback 崩了：');
  console.error(error);
  process.exitCode = 1;
});
