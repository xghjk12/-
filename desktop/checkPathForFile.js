'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * t5 前置验证：`webUtils.getPathForFile(file)` 在壳里到底能不能用（任务书要求先验证）。
 *
 * 背景：曲库是 `FileSystemDirectoryHandle`，拿不到绝对路径；补歌词工具要路径。
 * Electron 官方出路 = preload 里用 `webUtils.getPathForFile(file)` 反查，而 File
 * 要从渲染进程穿过 contextBridge 传进来——这两步能不能成，直接决定 t5 走
 * "自动反推曲库根目录"还是"设置里手填路径"。
 *
 * 方法（真实用户路径，不用脚本凭空捏造）：
 *   1. 造一个封闭曲库目录（从 新建文件夹 拷 1 个音频文件，不带 .lrc）
 *   2. Playwright 驱动真入口 + selftest 钩子
 *   3. 真实点击「选择音乐文件夹」→ driveFolderDialog.ps1 驱动原生对话框选那个目录
 *   4. 扫描完成后，从 IndexedDB 的 handles store 取回目录句柄（music-root），
 *      取第一个文件句柄的 File → 调 `window.qingyinDesktop.lyrics.getTrackPath(file)`
 *   5. 比对：返回的绝对路径应等于 曲库目录 + 文件名；再拿一个内存构造的假 File
 *      验证"非磁盘背书的 File 返回空串"（调用方的兜底依据）
 *
 * 用法：node desktop/checkPathForFile.js
 * 产物：artifacts/desktop/path-for-file.json
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const ORIGIN = 'http://127.0.0.1:53140';
const MUSIC_FOLDER = path.join(artifactsDir, 'path-probe-music');
const SOURCE_FOLDER = 'D:\\轻音播放\\新建文件夹';

const AUDIO_EXTENSIONS = /\.(mp3|flac|m4a|wav|ogg|wma|ape|strm)$/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 新建文件夹 拷 1 个音频文件到封闭目录（保证有真实磁盘文件，且不碰用户数据）。 */
function prepareMusicFolder() {
  fs.rmSync(MUSIC_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(MUSIC_FOLDER, { recursive: true });
  const audio = fs
    .readdirSync(SOURCE_FOLDER)
    .filter((name) => AUDIO_EXTENSIONS.test(name) && !name.toLowerCase().endsWith('.lrc'))
    .sort()[0];
  if (!audio) throw new Error(`在 ${SOURCE_FOLDER} 找不到音频文件`);
  fs.copyFileSync(path.join(SOURCE_FOLDER, audio), path.join(MUSIC_FOLDER, audio));
  return audio;
}

/** 启动对话框驱动（与 checkDirectoryPicker.js 同一套）。 */
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

async function main() {
  const seededFile = prepareMusicFolder();
  console.log(`electron : ${electronPath}`);
  console.log(`封闭曲库: ${MUSIC_FOLDER}`);
  console.log(`音频文件: ${seededFile}`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, '--no-sandbox', `--user-data-dir=${path.join(artifactsDir, 'userdata-path-probe')}`],
    cwd: repoRoot,
    env,
    timeout: 60000,
  });
  const facts = {};
  const problems = [];

  try {
    const win = await app.firstWindow({ timeout: 60000 });
    await win.waitForLoadState('domcontentloaded');
    await win.goto(`${ORIGIN}/?selftest=1`, { waitUntil: 'domcontentloaded' });
    await win.waitForSelector('.row, .empty', { timeout: 60000 });

    // 先清掉上次的曲库存档，保证这次扫描就是我们的封闭目录
    await win.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('qingyin-player', 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').delete('music-root');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });

    const driver = startDialogDriver();
    const button = win.locator('button:has-text("选择音乐文件夹")').first();
    await button.click({ timeout: 15000 });
    console.log('已真实点击「选择音乐文件夹」');

    // 等扫描完成（曲库行数 = 1）
    let scan = null;
    for (let i = 0; i < 120; i += 1) {
      scan = await win.evaluate(() => window.__qingyinTest?.scan());
      const rows = await win.evaluate(() => document.querySelectorAll('.row').length);
      if (scan && !scan.active && rows >= 1) break;
      await sleep(500);
    }
    driver.kill();
    facts.scan = { active: scan?.active, phase: scan?.phase, total: scan?.total };
    console.log(`扫描: ${JSON.stringify(facts.scan)}`);

    // 核心：从句柄拿 File → getTrackPath
    const result = await win.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('qingyin-player', 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readonly');
        const rq = tx.objectStore('handles').get('music-root');
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
      if (!handle) return { found: false };
      let firstFile = null;
      let relPath = null;
      for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
          relPath = entry.name;
          firstFile = await entry.getFile();
          break;
        }
      }
      if (!firstFile) return { found: false };
      const bridge = window.qingyinDesktop?.lyrics;
      let diskPath = null;
      let diskError = null;
      try {
        diskPath = bridge?.getTrackPath ? await bridge.getTrackPath(firstFile) : '(bridge 缺失)';
      } catch (error) {
        diskError = String(error);
      }
      // 对照组：内存构造的假 File（非磁盘背书），预期返回空串
      let fakePath = null;
      let fakeError = null;
      try {
        const fake = new File([new Uint8Array([1, 2, 3])], 'fake.mp3');
        fakePath = bridge?.getTrackPath ? await bridge.getTrackPath(fake) : '(bridge 缺失)';
      } catch (error) {
        fakeError = String(error);
      }
      return {
        found: true,
        handleName: handle.name,
        relPath,
        name: firstFile.name,
        size: firstFile.size,
        diskPath,
        diskError,
        fakePath,
        fakeError,
      };
    });
    facts.result = result;
    console.log(`\n== getTrackPath 结果 ==`);
    console.log(JSON.stringify(result, null, 2));

    // 判定
    const expected = path.join(MUSIC_FOLDER, String(result?.relPath));
    if (!result?.found) {
      problems.push('没能在 IndexedDB 里取回目录句柄（扫描没跑成？）');
    } else if (result.diskError) {
      problems.push(`getTrackPath 抛错：${result.diskError}`);
    } else if (typeof result.diskPath !== 'string' || result.diskPath.toLowerCase() !== expected.toLowerCase()) {
      problems.push(`getTrackPath = ${JSON.stringify(result.diskPath)} ≠ 预期 ${expected}`);
    }
    if (result?.fakeError) {
      problems.push(`假 File 也抛错：${result.fakeError}`);
    } else if (result && result.fakePath !== '') {
      problems.push(`假 File 应返回空串，实际 ${JSON.stringify(result.fakePath)}`);
    }
  } catch (error) {
    problems.push(`验证没跑完：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await app.close();
    } catch {
      // 进程可能已经自己退了
    }
  }

  const report = {
    when: new Date().toISOString(),
    musicFolder: MUSIC_FOLDER,
    seededFile,
    facts,
    problems,
    canDeriveRoot: problems.length === 0,
  };
  fs.mkdirSync(artifactsDir, { recursive: true });
  const reportPath = path.join(artifactsDir, 'path-for-file.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n== 结论 ==');
  if (report.canDeriveRoot) {
    console.log('  webUtils.getPathForFile 可用：真实曲库 File 反查绝对路径成功，');
    console.log('  → t5 走「自动反推曲库根目录」主路，musicFolderPath 只做兜底。');
  } else {
    console.log('  getPathForFile 不可用或行为不符预期（见 problems）。');
    console.log('  → t5 退到「设置里手填音乐文件夹路径」的路。');
  }
  if (problems.length > 0) {
    console.error(`\n异常：\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
