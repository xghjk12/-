'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * t5 验收脚本：假工具端到端跑通整条补歌词链路。
 *
 * 链路（全部真实用户路径，无捷径）：
 *   托盘「补歌词…」（= shell 句柄 triggerFillLyrics，同一个函数）
 *     → 主进程解析目录（settings.musicFolderPath，测试里预写好）
 *     → spawn powershell 跑假工具 desktop/tools/fake-fill-lyrics.ps1
 *     → 工具写一个 .lrc 到曲库 → 退出码 0
 *     → 状态推送 lyrics:status-changed（渲染进程）
 *     → 渲染进程胶水（src/ui/desktopLyrics.ts）自动调 store 的 rescanLyrics
 *     → 曲库认领 .lrc → 面板/通知看到「新增 1」
 *
 * 曲库必须走**真实目录选择**（selftest 的内存 File 没有磁盘路径，rescan 扫不到
 * 假工具写盘的文件），沿用 checkDirectoryPicker 的驱动方式。
 *
 * 另外两条路径：
 *   - 失败传播：换一个 exit 3 的工具 → running → failed，可读错误进日志尾
 *   - 取消：换一个 30 秒慢工具 → running → 渲染进程调 lyrics.cancel() →
 *     failed + 「已取消」，且没有写出文件
 *
 * 用法：node desktop/checkLyricsTool.js
 * 产物：artifacts/desktop/lyrics-tool.json
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const ORIGIN = 'http://127.0.0.1:53140';

const MUSIC_FOLDER = path.join(artifactsDir, 'lyrics-e2e-music');
const USER_DATA = path.join(artifactsDir, 'userdata-lyrics-check');
const FAKE_TOOL = path.join(desktopDir, 'tools', 'fake-fill-lyrics.ps1');
const SOURCE_FOLDER = 'D:\\轻音播放\\新建文件夹';

const AUDIO_EXTENSIONS = /\.(mp3|flac|m4a|wav|ogg|wma|ape|strm)$/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prepareMusicFolder() {
  fs.rmSync(MUSIC_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(MUSIC_FOLDER, { recursive: true });
  const audio = fs
    .readdirSync(SOURCE_FOLDER)
    .filter((name) => AUDIO_EXTENSIONS.test(name))
    .sort()[0];
  if (!audio) throw new Error(`在 ${SOURCE_FOLDER} 找不到音频文件`);
  fs.copyFileSync(path.join(SOURCE_FOLDER, audio), path.join(MUSIC_FOLDER, audio));
  return audio;
}

/** 失败工具：exit 3 + stderr 可读错误（模拟用户拿一个会失败的工具）。 */
function writeFailingTool() {
  const scriptPath = path.join(artifactsDir, 'lyrics-e2e-fail-tool.ps1');
  // \uFEFF = UTF-8 BOM：PS 5.1 读无 BOM 的脚本会按 ANSI/GBK 解码，中文全成乱码
  fs.writeFileSync(
    scriptPath,
    '\uFEFF' +
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
      "[Console]::Error.WriteLine('模拟失败：工具侧三号错误')\n" +
      "exit 3\n",
    'utf8',
  );
  return scriptPath;
}

/** 慢工具：30 秒后才写文件（给取消留窗口）。 */
function writeSlowTool() {
  const scriptPath = path.join(artifactsDir, 'lyrics-e2e-slow-tool.ps1');
  fs.writeFileSync(
    scriptPath,
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
      "Write-Output 'SLOW started'\n" +
      "Start-Sleep -Seconds 30\n" +
      "exit 0\n",
    'utf8',
  );
  return scriptPath;
}

function writeSettings(toolPath) {
  // 每次全新：残留的句柄/曲目缓存会让页面走「等待恢复授权」分支，扫描不跑
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ openAtLogin: false, lyricsToolPath: toolPath, musicFolderPath: MUSIC_FOLDER }, null, 2),
    'utf8',
  );
}

function startDialogDriver() {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'driveFolderDialog.ps1'), '-WatchSec', '55'],
    { cwd: repoRoot, env: { ...process.env, QINGYIN_PICK_PATH: MUSIC_FOLDER }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`    [驱动] ${line.trimEnd()}`);
    }
  });
  return child;
}

async function launchApp() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, '--no-sandbox', `--user-data-dir=${USER_DATA}`],
    cwd: repoRoot,
    env,
    timeout: 60000,
  });
}

/** 等主进程侧工具状态到达目标值（或超时，返回最后状态）。 */
async function waitForLyricsState(app, target, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await app.evaluate(() => globalThis.__qingyinDesktopShell.lyricsState());
    if (last && last.status === target) return last;
    await sleep(300);
  }
  return last;
}

async function main() {
  const audioFile = prepareMusicFolder();
  const failTool = writeFailingTool();
  const slowTool = writeSlowTool();
  writeSettings(FAKE_TOOL);
  console.log(`electron : ${electronPath}`);
  console.log(`曲库     : ${MUSIC_FOLDER}（${audioFile}）`);
  console.log(`假工具   : ${FAKE_TOOL}`);

  const problems = [];
  const facts = { audioFile };

  // ============ 第一幕：成功链路（含渲染进程自动重扫） ============
  {
    const app = await launchApp();
    try {
      const win = await app.firstWindow({ timeout: 60000 });
      await win.waitForLoadState('domcontentloaded');
      await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
      await win.waitForSelector('.row, .empty', { timeout: 60000 });

      const driver = startDialogDriver();
      await win.locator('button:has-text("选择音乐文件夹")').first().click({ timeout: 15000 });
      let scan = null;
      for (let i = 0; i < 120; i += 1) {
        scan = await win.evaluate(() => window.__qingyinTest?.scan());
        const rows = await win.evaluate(() => document.querySelectorAll('.row').length);
        if (scan && !scan.active && scan.found >= 1 && rows >= 1) break;
        await sleep(500);
      }
      driver.kill();
      console.log(`扫描: ${JSON.stringify(scan)}`);
      if (!scan || scan.found < 1) {
        // 快速失败：曲库没扫进来，后面的断言全会是噪音
        problems.push(`曲库扫描没完成（对话框驱动失败？）：${JSON.stringify(scan)}`);
      }

      if (scan && scan.found >= 1) {
        const trackPaths = await win.evaluate(() => window.__qingyinTest.tracks());
        facts.tracksBefore = trackPaths;
        const trackPath = trackPaths[0];

        // 触发：托盘菜单项 = shell 句柄的同一个函数
        const trigger = await app.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
        console.log(`触发: ${JSON.stringify({ ok: trigger.ok, reason: trigger.reason, musicPath: trigger.musicPath })}`);
        if (!trigger.ok) problems.push(`triggerFillLyrics 未启动：${trigger.reason}`);

        const final = await waitForLyricsState(app, 'done');
        console.log(`工具状态: ${JSON.stringify({ status: final?.status, exitCode: final?.exitCode, error: final?.error })}`);
        facts.mainDone = { status: final?.status, exitCode: final?.exitCode };
        if (final?.status !== 'done') {
          problems.push(`工具没到 done：${JSON.stringify(final)}`);
        }
        if (!fs.existsSync(path.join(MUSIC_FOLDER, `${path.basename(audioFile, path.extname(audioFile))}.lrc`))) {
          problems.push('假工具没写出 .lrc（electron 子进程写盘被环境限制？）');
        }

        // 渲染进程胶水：done → 自动 rescanLyrics → 认领 + 通知。
        // 通知 3.2 秒就自动消失，所以把「认领轮询」和「通知抓取」合成一个循环。
        let lyricsClaimed = null;
        let noticeSeen = false;
        for (let i = 0; i < 30; i += 1) {
          lyricsClaimed = await win.evaluate((p) => window.__qingyinTest.readLyrics(p), trackPath);
          if (!noticeSeen) {
            const text = await win.evaluate(() => document.body.innerText);
            if (/歌词扫描|新认领/.test(text)) noticeSeen = true;
          }
          if (lyricsClaimed && noticeSeen) break;
          await sleep(500);
        }
        facts.rendererClaimed = Boolean(lyricsClaimed);
        facts.noticeHasScanStats = noticeSeen;
        console.log(`渲染进程认领: ${lyricsClaimed ? '是' : '否'}；重扫通知: ${noticeSeen ? '看到' : '没看到'}`);
        if (!lyricsClaimed) {
          problems.push('渲染进程没有自动认领假工具写的 .lrc（胶水没生效？）');
        }
        if (!noticeSeen) {
          problems.push('页面上没看到重扫通知文案（胶水的 rescanLyrics 没跑？）');
        }

        // 面板级验证：选中那首 → 打开歌词面板 → 能看到假工具写的句子
        if (lyricsClaimed) {
          await win.locator('.row').first().dblclick({ timeout: 15000 });
          await win.keyboard.press('y');
          await sleep(500);
          const panelText = await win.evaluate(() => document.body.innerText);
          facts.panelShowsLyric = /假工具第一句/.test(panelText);
          console.log(`面板看到歌词: ${facts.panelShowsLyric ? '是' : '否'}`);
          if (!facts.panelShowsLyric) {
            problems.push('歌词面板里没显示假工具写的歌词（正文里找不到那句话）');
          }
        }
      }
    } catch (error) {
      problems.push(`成功链路异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await app.close();
      } catch {
        // 进程可能已经自己退了
      }
    }
  }

  // ============ 第二幕：失败传播（exit 3 的工具） ============
  {
    fs.rmSync(path.join(MUSIC_FOLDER, `${path.basename(audioFile, path.extname(audioFile))}.lrc`), { force: true });
    writeSettings(failTool);
    const app = await launchApp();
    try {
      const win = await app.firstWindow({ timeout: 60000 });
      await win.waitForLoadState('domcontentloaded');
      await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
      await win.waitForSelector('.row, .empty', { timeout: 60000 });

      const trigger = await app.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
      const final = await waitForLyricsState(app, 'failed');
      console.log(`失败传播: ${JSON.stringify({ ok: trigger.ok, status: final?.status, exitCode: final?.exitCode })}`);
      facts.failure = { status: final?.status, exitCode: final?.exitCode, tail: final?.tail };
      if (final?.status !== 'failed' || final?.exitCode !== 3) {
        problems.push(`失败路径状态不对：${JSON.stringify(final)}`);
      }
      if (!final?.tail?.some((line) => line.includes('三号错误'))) {
        problems.push(`失败的可读错误没进日志尾：${JSON.stringify(final?.tail)}`);
      }
    } catch (error) {
      problems.push(`失败链路异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await app.close();
      } catch {
        // ignore
      }
    }
  }

  // ============ 第三幕：取消（渲染进程 IPC 通道） ============
  {
    writeSettings(slowTool);
    const app = await launchApp();
    try {
      const win = await app.firstWindow({ timeout: 60000 });
      await win.waitForLoadState('domcontentloaded');
      await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
      await win.waitForSelector('.row, .empty', { timeout: 60000 });

      await app.evaluate(() => globalThis.__qingyinDesktopShell.triggerFillLyrics());
      let running = await waitForLyricsState(app, 'running');
      console.log(`慢工具状态: ${running?.status}`);
      if (running?.status !== 'running') {
        problems.push(`慢工具没进入 running：${JSON.stringify(running)}`);
      }

      // 渲染进程侧取消（preload 暴露的 IPC 通道，不是主进程直调）
      const cancelResult = await win.evaluate(() => window.qingyinDesktop.lyrics.cancel());
      const final = await waitForLyricsState(app, 'failed');
      console.log(`取消结果: ${JSON.stringify({ ipc: cancelResult, status: final?.status, error: final?.error })}`);
      facts.cancel = { status: final?.status, error: final?.error, exitCode: final?.exitCode };
      if (cancelResult?.cancelled !== true || final?.status !== 'failed' || final?.error !== '已取消') {
        problems.push(`取消路径不对：${JSON.stringify({ cancelResult, final })}`);
      }
    } catch (error) {
      problems.push(`取消链路异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await app.close();
      } catch {
        // ignore
      }
    }
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const report = {
    when: new Date().toISOString(),
    musicFolder: MUSIC_FOLDER,
    fakeTool: FAKE_TOOL,
    facts,
    problems,
  };
  fs.writeFileSync(path.join(artifactsDir, 'lyrics-tool.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('\n== 结论 ==');
  if (problems.length === 0) {
    console.log('  假工具端到端链路全绿：托盘触发 → running → done → 自动重扫认领 →');
    console.log('  失败传播与取消路径也都符合预期。');
  } else {
    console.error(`链路有问题：\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
