'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * 实测 `showDirectoryPicker()` 在 Electron 壳里到底能不能用（README §3 的遗留问题 5）。
 *
 * 背景与动机：probe 只量到 `typeof window.showDirectoryPicker === 'function'`，
 * 没验证"真点下去会不会弹窗、选完能不能扫进曲库"。这个实验的结果直接决定
 * 桌面端要不要做 fs 桥——能用的话浏览器路径直接可用，桥就不用写。
 *
 * 方法（严格走真实用户路径，不用脚本凭空调用）：
 *   1. Playwright 驱动真入口（desktop/main.js），加载 `/?selftest=1` 拿测试钩子
 *   2. 先在页面里把 `window.showDirectoryPicker` 包一层探针（不改仓库代码，
 *      包完之后原函数仍在同一次用户手势里被调用），捕获成功/失败的原文
 *   3. 用 Playwright **真实点击**应用自己的「选择音乐文件夹」按钮（CDP 输入
 *      事件带用户激活，不是 evaluate 凭空调用）
 *   4. 若弹出 Windows 原生目录对话框，spawn driveFolderDialog.ps1 用 UI
 *      Automation 填路径并点「选择文件夹」；若没有对话框，几秒内探针就会
 *      记下报错原文
 *   5. 观察扫描是否跑起来：曲目数、.lrc 认领数、扫描统计，截图留档
 *
 * 用法（仓库根目录）：
 *   node desktop/checkDirectoryPicker.js
 *   （可选：$env:QINGYIN_PICK_PATH 换目标目录，默认 D:\轻音播放\新建文件夹）
 *
 * 产物：artifacts/desktop/directory-picker.json + directory-picker.png
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const ORIGIN = 'http://127.0.0.1:53140';
const TARGET_FOLDER = process.env.QINGYIN_PICK_PATH || 'D:\\轻音播放\\新建文件夹';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 启动「监视 + 驱动」脚本：输出流式回传，返回 { child, done }。 */
function startDialogDriver() {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'driveFolderDialog.ps1'),
      '-WatchSec',
      '55',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, QINGYIN_PICK_PATH: TARGET_FOLDER },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    out += text;
    for (const line of text.split('\n')) {
      if (line.trim()) console.log(`    [驱动] ${line.trimEnd()}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    out += chunk;
  });
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, out: out.trim() }));
    child.on('error', (error) => resolve({ code: -1, out: String(error) }));
  });
  return { child, done };
}

/** 桌面快照：全屏截图 + 全量可见顶层窗口转储（回答"屏幕上有没有对话框"）。 */
function snapshot(tag) {
  return new Promise((resolve) => {
    const shotPath = path.join(artifactsDir, `picker-screen-${tag}.png`);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'snapshotDesktop.ps1')],
      { cwd: repoRoot, env: { ...process.env, QY_SHOT_PATH: shotPath }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', () => resolve(out.trim()));
    child.on('error', (error) => resolve(String(error)));
  });
}

async function main() {
  const env = { ...process.env };
  // 坑 1：DSH 终端会把 ELECTRON_RUN_AS_NODE 传给子进程，带着它 electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`electron : ${electronPath}`);
  console.log(`目标目录: ${TARGET_FOLDER}`);

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, '--no-sandbox'],
    cwd: repoRoot,
    env,
    timeout: 60000,
  });
  const pid = app.process().pid;

  const consoleErrors = [];
  const facts = {};
  const problems = [];
  try {
    const win = await app.firstWindow({ timeout: 60000 });
    win.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    win.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await win.waitForLoadState('domcontentloaded');
    // 装测试钩子（正式入口只有 ?selftest=1 才挂 __qingyinTest）
    await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
    await win.waitForSelector('.row, .empty', { timeout: 60000 });

    const before = await win.evaluate(() => ({
      hasHooks: typeof window.__qingyinTest !== 'undefined',
      typeofShowDirectoryPicker: typeof window.showDirectoryPicker,
      rows: document.querySelectorAll('.row').length,
    }));
    console.log('\n== 点击前 ==');
    console.log(`  typeof showDirectoryPicker: ${before.typeofShowDirectoryPicker}`);
    console.log(`  现有曲库行数: ${before.rows}`);

    // 探针：包一层 showDirectoryPicker，不改任何仓库代码。
    // 包装函数在同一个用户手势任务里同步调用原函数，不改变激活语义。
    await win.evaluate(() => {
      const original = window.showDirectoryPicker;
      window.__pickerProbe = { state: 'pending', hasFn: typeof original };
      if (typeof original === 'function') {
        window.showDirectoryPicker = async (...args) => {
          try {
            const handle = await original.apply(window, args);
            window.__pickerProbe = { state: 'ok', name: handle?.name, kind: handle?.kind };
            return handle;
          } catch (error) {
            window.__pickerProbe = {
              state: 'error',
              name: error?.name,
              message: error?.message,
            };
            throw error;
          }
        };
      }
    });

    // 真实点击：应用自己的按钮（CDP 输入 → 用户手势）
    const clickAt = Date.now();
    const button = win.locator('button:has-text("选择音乐文件夹")').first();
    await button.click({ timeout: 15000 });
    console.log('\n已点击「选择音乐文件夹」按钮（真实点击）');

    // 记录探针状态变化的时间线（resolve/reject 的时刻本身是重要证据）
    const timeline = [];
    const sample = async () => {
      const value = await win.evaluate(() => window.__pickerProbe);
      const last = timeline[timeline.length - 1];
      if (!last || JSON.stringify(last.probe) !== JSON.stringify(value)) {
        timeline.push({ atMs: Date.now() - clickAt, probe: value });
        console.log(`  t+${timeline[timeline.length - 1].atMs}ms  probe = ${JSON.stringify(value)}`);
      }
      return value;
    };

    // 点击后立刻启动「监视 + 驱动」：它一边记录窗口时间线，一边尝试驱动对话框
    const driver = startDialogDriver();

    // 等探针出结果（选完目录 → ok；取消 → error AbortError）。
    // 挂起期间在 t+2s / t+6.5s / t+11.5s 拍全屏快照 + 全量窗口转储：
    // 对话框到底有没有出现在屏幕上，这是判定的核心证据。
    let probe = { state: 'pending' };
    const snapshots = [];
    for (let i = 0; i < 100 && probe?.state === 'pending'; i += 1) {
      await sleep(500);
      probe = await sample();
      if ((i === 3 || i === 12 || i === 22) && probe?.state === 'pending') {
        const at = `t${((i + 1) * 0.5).toFixed(1)}s`;
        const out = await snapshot(at);
        snapshots.push({ at, out });
        console.log(`  [快照 ${at}]`);
        for (const line of out.split('\n')) {
          if (/选择|文件夹|folder|Folder|electron|#32770|CoreWindow|Dialog|对话框|SHOT/.test(line)) {
            console.log(`    ${line}`);
          }
        }
      }
    }
    facts.snapshots = snapshots;
    facts.timeline = timeline;
    // 探针已定，监视器不需要再跑了
    driver.child.kill();
    const dialogDrive = await driver.done;
    facts.dialogDrive = { code: dialogDrive.code, out: dialogDrive.out };

    console.log('\n== showDirectoryPicker 结果 ==');
    console.log(`  ${JSON.stringify(probe)}`);

    facts.probe = probe;
    facts.dialogDrive = dialogDrive ? { code: dialogDrive.code, out: dialogDrive.out } : null;

    if (probe?.state === 'ok') {
      // 等扫描跑完
      let scan = null;
      for (let i = 0; i < 120; i += 1) {
        scan = await win.evaluate(() => window.__qingyinTest?.scan());
        if (scan && !scan.active && (scan.phase === 'done' || scan.phase === 'idle' || scan.phase === 'aborted')) break;
        await sleep(500);
      }
      const library = await win.evaluate(async () => {
        const hooks = window.__qingyinTest;
        const paths = hooks.tracks();
        const claimed = [];
        for (const p of paths) {
          const record = await hooks.readLyrics(p);
          if (record) claimed.push(p);
        }
        return {
          scan: hooks.scan(),
          trackCount: paths.length,
          titles: Array.from(document.querySelectorAll('.row .title-main')).map((n) => n.textContent.trim()),
          rows: document.querySelectorAll('.row').length,
          lyricFiles: await hooks.lyricFiles(),
          claimedLyricCount: claimed.length,
          claimedLyricSample: claimed.slice(0, 5),
          sideRoot: document.querySelector('.side-root')?.textContent.trim() ?? '',
        };
      });

      facts.scan = library.scan;
      facts.trackCount = library.trackCount;
      facts.rows = library.rows;
      facts.lyricFiles = library.lyricFiles;
      facts.claimedLyricCount = library.claimedLyricCount;
      facts.claimedLyricSample = library.claimedLyricSample;
      facts.sideRoot = library.sideRoot;

      console.log('\n== 扫描结果 ==');
      console.log(`  曲目数: ${library.trackCount}（DOM 行数 ${library.rows}）`);
      console.log(`  歌词文件: ${JSON.stringify(library.lyricFiles)}`);
      console.log(`  已认领歌词的曲目数: ${library.claimedLyricCount}`);
      console.log(`  曲库来源: ${library.sideRoot || '(未显示)'}`);

      if (library.trackCount !== 22) problems.push(`曲目数 ${library.trackCount} ≠ 预期的 22`);
      if (library.claimedLyricCount !== 16) problems.push(`已认领歌词 ${library.claimedLyricCount} ≠ 预期的 16`);
    }

    const shotPath = path.join(artifactsDir, 'directory-picker.png');
    await win.screenshot({ path: shotPath });
    console.log(`\n截图: ${path.relative(repoRoot, shotPath)}`);
  } catch (error) {
    problems.push(`实验没跑完：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await app.close();
    } catch {
      // 进程可能已经自己退了
    }
  }

  const report = {
    when: new Date().toISOString(),
    targetFolder: TARGET_FOLDER,
    electronPid: pid,
    consoleErrors,
    facts,
    problems,
    canPick: facts.probe?.state === 'ok',
  };
  fs.mkdirSync(artifactsDir, { recursive: true });
  const reportPath = path.join(artifactsDir, 'directory-picker.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n== 结论 ==');
  if (report.canPick) {
    console.log('  showDirectoryPicker 在壳里可用：弹出原生目录对话框，选中目录后曲库正常扫描。');
    console.log('  → 桌面端可以直接复用浏览器路径，fs 桥降级为"更好的体验"而不是唯一出路。');
  } else {
    console.log(`  showDirectoryPicker 不可用或被拒：${JSON.stringify(facts.probe ?? null)}`);
    console.log('  → 需要 fs 桥（README §4 的设计）。');
  }
  if (problems.length > 0) {
    console.error(`\n实验异常：\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
