#!/usr/bin/env node
/**
 * 界面冒烟：用**本机已装的 Edge（Chromium 内核）**驱动真实浏览器，跑一遍产品本身。
 *
 * 为什么用 Edge 而不是让 Playwright 下载 Chromium：本机已有 Edge，而 `playwright-core`
 * 本身不下载浏览器，所以这条路零下载。
 *
 * 它**不进 `pnpm verify`**：它依赖「本机装了 Edge」，属于开发机上的辅助验证，
 * 而 verify 要能在任何环境跑。可移植的那部分是 typecheck + test + check:bundle。
 *
 * 它覆盖的是自动化确实能覆盖的那一段：
 *   1. 页面能真正在浏览器里跑起来，且没有控制台报错 / 未捕获异常
 *   2. 内置自检逐项通过（真实 flac / mp3 在浏览器里解析；四种播放模式的推进；
 *      500 首时虚拟化只渲染视口内的行）
 *   3. 完整链路：内置样本 → 扫描入库（真写 IndexedDB）→ 列表渲染 → 双击播放
 *      → 断言 `<audio>` 真的在推进（这是"真实出声"最接近的自动化替身）
 *   4. 留一张截图，供人（或 AI）肉眼确认版面
 *
 * 用法：pnpm check:ui
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const shotDir = path.join(root, 'artifacts', 'ui');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.ape': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

console.log('== 1/5 构建产物 ==');
execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });

/** 只服务 dist 下的文件，路径穿越直接拒绝。 */
function startStaticServer() {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const target = path.join(distDir, pathname === '/' ? 'index.html' : pathname);
    if (!target.startsWith(distDir)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await startStaticServer();
const url = `http://127.0.0.1:${port}/?selftest=1`;
console.log(`== 2/5 启动浏览器（本机 Edge）==\n   ${url}`);

const problems = [];
let browser;
const result = { selfCheck: null, playback: null, queue: null, screenshot: null, consoleErrors: [] };

try {
  // channel 指向本机 Edge；playwright-core 不带浏览器，所以这里不会触发下载
  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    // 允许无声播放，避免 headless 下自动播放策略把 play() 拒掉
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url: resourceUrl } = message.location();
    result.consoleErrors.push(resourceUrl ? `${message.text()} (${resourceUrl})` : message.text());
  });
  page.on('pageerror', (error) => result.consoleErrors.push(`未捕获异常: ${error.message}`));
  page.on('requestfailed', (request) =>
    result.consoleErrors.push(`请求失败: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );

  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

  console.log('\n== 3/5 内置自检 ==');
  await page.waitForSelector('#selfTestResult table', { timeout: 45_000 });
  result.selfCheck = await page.evaluate(() => {
    const panel = document.querySelector('#selfTestResult');
    const heading = panel?.querySelector('h2')?.textContent?.trim() ?? '';
    const rows = [...(panel?.querySelectorAll('table tr') ?? [])].slice(1).map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim());
      return { label: cells[0], actual: cells[1], expected: cells[2], verdict: cells[3] };
    });
    return { heading, rows, verdict: panel?.dataset.verdict };
  });
  console.log(`   ${result.selfCheck.heading}`);
  for (const row of result.selfCheck.rows) {
    console.log(`   ${row.verdict === '通过' ? '✓' : '✗'} ${String(row.label).padEnd(30)} ${row.actual}`);
  }
  if (result.selfCheck.verdict !== 'pass') {
    problems.push(`内置自检未全部通过：${result.selfCheck.heading}`);
    for (const row of result.selfCheck.rows.filter((item) => item.verdict !== '通过')) {
      problems.push(`自检失败项：${row.label}（实际 ${row.actual}，期望 ${row.expected}）`);
    }
  }

  console.log('\n== 4/5 完整链路：导入 → 入库 → 列表 → 播放 ==');
  const scanned = await page.evaluate(async () => {
    const count = await window.__qingyinTest.loadFixtureLibrary();
    return { count, paths: window.__qingyinTest.tracks() };
  });
  console.log(`   导入内置样本 ${scanned.count} 首：${scanned.paths.join('、')}`);
  if (scanned.count < 4) problems.push(`内置样本没有全部入库（期望 4，实际 ${scanned.count}）`);
  await page.waitForSelector('.row', { timeout: 15_000 });
  const renderedRows = await page.locator('.row').count();

  const flacIndex = scanned.paths.findIndex((item) => item.endsWith('.flac'));
  if (flacIndex < 0) problems.push('内置样本里没有 flac，无法验证播放');
  else await page.locator('.row').nth(flacIndex).dblclick();

  // 真的在出声：<audio> 不再暂停，且 currentTime 在推进
  let progressed = false;
  try {
    await page.waitForFunction(
      () => !window.__qingyinTest.paused() && window.__qingyinTest.positionSec() > 0.05,
      undefined,
      { timeout: 15_000 },
    );
    progressed = true;
  } catch {
    progressed = false;
  }

  result.playback = await page.evaluate(() => ({
    ...window.__qingyinTest.state(),
    positionSec: window.__qingyinTest.positionSec(),
    durationSec: window.__qingyinTest.durationSec(),
    paused: window.__qingyinTest.paused(),
    src: window.__qingyinTest.audioSrc(),
    rows: document.querySelectorAll('.row').length,
  }));

  console.log(
    `   列表渲染 ${renderedRows} 行；播放状态 paused=${result.playback.paused} ` +
      `position=${result.playback.positionSec.toFixed(2)}s duration=${result.playback.durationSec.toFixed(1)}s`,
  );
  console.log(`   音源：${result.playback.src.slice(0, 48)}…`);

  if (!progressed) {
    problems.push('双击曲目后音频没有推进（可能是自动播放策略或对象 URL 失败）');
  }
  if (!result.playback.src.startsWith('blob:')) {
    problems.push(`音频没有走对象 URL（实际 ${result.playback.src.slice(0, 32)}）`);
  }
  if (result.playback.durationSec < 1) {
    problems.push(`读到的时长异常：${result.playback.durationSec}`);
  }

  // 不支持格式：双击 APE 应当给出说明并自动跳到下一首可播放的曲目（技术方案 8.2）
  const apeIndex = scanned.paths.findIndex((item) => item.endsWith('.ape'));
  if (apeIndex >= 0) {
    await page.locator('.row').nth(apeIndex).dblclick();
    // 提示是叠加出现的，要等的是「那一条」说明，而不是随便一条提示
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('.notice')].some((node) => node.textContent?.includes('无法解码')),
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const skipped = await page.evaluate(() => ({
      notices: [...document.querySelectorAll('.notice')].map((node) => node.textContent?.trim() ?? ''),
      resumePath: window.__qingyinTest.state().resumePath,
      paused: window.__qingyinTest.paused(),
    }));
    console.log(`   APE 跳过：播放 ${skipped.resumePath}；提示 ${skipped.notices.join(' / ')}`);
    if (!skipped.notices.some((text) => text.includes('无法解码'))) {
      problems.push('不可播放的曲目没有给出说明');
    }
    if (!skipped.resumePath?.endsWith('plain.mp3')) {
      problems.push(`没有自动跳到下一首可播放的曲目（实际 ${skipped.resumePath}）`);
    }
    if (skipped.paused) problems.push('跳到可播放曲目后没有开始播放');
  }

  // 队列抽屉
  await page.click('button[title="播放队列"]');
  await page.waitForSelector('.queue', { timeout: 5_000 });
  result.queue = await page.evaluate(() => ({
    open: window.__qingyinTest.state().queueOpen,
    items: document.querySelectorAll('.queue-item').length,
  }));
  console.log(`   队列抽屉：${result.queue.items} 项`);
  if (result.queue.items < 1) problems.push('播放队列是空的（双击后应当至少有一项）');

  // ---- 增量缓存：同一批文件再导入一次，必须全部命中（真实 IndexedDB 的命中路径）----
  console.log('\n== 4b 增量缓存与状态持久化 ==');
  const second = await page.evaluate(async () => {
    const count = await window.__qingyinTest.loadFixtureLibrary();
    return { count, scan: window.__qingyinTest.scan() };
  });
  console.log(
    `   二次导入 ${second.count} 首：缓存命中 ${second.scan.reused}、新解析 ${second.scan.parsed}、` +
      `遍历 ${second.scan.listingMs}ms、扫描 ${second.scan.elapsedMs}ms`,
  );
  if (second.scan.reused < 4 || second.scan.parsed !== 0) {
    problems.push(
      `增量缓存没有全部命中（命中 ${second.scan.reused}、新解析 ${second.scan.parsed}）`,
    );
  }

  // 改音量与播放模式，并把进度跳到一个确定值再落盘，稍后验证它们都能从 IndexedDB 恢复
  const SEEK_TO = 1.25;
  await page.evaluate(async (positionSec) => {
    window.__qingyinTest.setVolume(0.42);
    window.__qingyinTest.cycleMode();
    await window.__qingyinTest.seekAndFlush(positionSec);
  }, SEEK_TO);
  await page.waitForTimeout(200);

  const persisted = await page.evaluate(() => window.__qingyinTest.readPersisted());
  console.log(
    `   持久化状态：音量 ${persisted?.volume}、模式 ${persisted?.mode}、` +
      `曲目 ${persisted?.trackPath}、进度 ${persisted?.positionSec?.toFixed(2)}s`,
  );
  if (!persisted) problems.push('没有从 IndexedDB 读到持久化的播放状态');
  else {
    if (Math.abs(persisted.volume - 0.42) > 0.001) problems.push(`音量没有落盘（${persisted.volume}）`);
    if (persisted.mode !== 'repeat-all') problems.push(`播放模式没有落盘（${persisted.mode}）`);
    if (!persisted.trackPath) problems.push('当前曲目没有落盘');
    if (Math.abs(persisted.positionSec - SEEK_TO) > 0.01) {
      problems.push(`播放进度没有落盘（期望 ${SEEK_TO}，实际 ${persisted.positionSec}）`);
    }
  }

  // ---- 刷新：列表必须纯靠缓存立刻回来，状态与进度一并恢复 ----
  await page.reload({ waitUntil: 'load', timeout: 30_000 });
  await page.waitForSelector('.row', { timeout: 15_000 });
  const afterReload = await page.evaluate(() => ({
    rows: document.querySelectorAll('.row').length,
    state: window.__qingyinTest.state(),
    scan: window.__qingyinTest.scan(),
    tracks: window.__qingyinTest.tracks().length,
  }));
  console.log(
    `   刷新后：列表 ${afterReload.rows} 行（缓存 ${afterReload.tracks} 首）、` +
      `扫描阶段 ${afterReload.scan.phase}、音量 ${afterReload.state.volume}、模式 ${afterReload.state.mode}、` +
      `恢复曲目 ${afterReload.state.resumePath}@${afterReload.state.resumePositionSec?.toFixed?.(2) ?? '-'}s`,
  );
  if (afterReload.tracks < 4) problems.push(`刷新后曲库没有从缓存恢复（${afterReload.tracks} 首）`);
  if (afterReload.rows < 1) problems.push('刷新后列表没有渲染');
  if (afterReload.scan.phase !== 'idle') problems.push('刷新后不应触发扫描');
  if (Math.abs(afterReload.state.volume - 0.42) > 0.001) {
    problems.push(`刷新后音量没有恢复（${afterReload.state.volume}）`);
  }
  if (afterReload.state.mode !== 'repeat-all') {
    problems.push(`刷新后播放模式没有恢复（${afterReload.state.mode}）`);
  }
  if (!afterReload.state.resumePath) problems.push('刷新后没有恢复上次播放的曲目');
  if (Math.abs(afterReload.state.resumePositionSec - SEEK_TO) > 0.05) {
    problems.push(
      `刷新后进度没有恢复（期望约 ${SEEK_TO}s，实际 ${afterReload.state.resumePositionSec}s）`,
    );
  }

  result.persistence = { persisted, afterReload };

  // 截图前收起自检面板，留一张干净的界面图
  await page.evaluate(() => document.getElementById('selfTestResult')?.remove());
  await mkdir(shotDir, { recursive: true });

  const shotPath = path.join(shotDir, 'app.png');
  await page.screenshot({ path: shotPath });
  result.screenshot = path.relative(root, shotPath);
  console.log(`\n   截图：${result.screenshot}`);
} catch (error) {
  problems.push(`浏览器冒烟未跑完：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close();
  server.close();
}

console.log('\n== 5/5 控制台 ==');
if (result.consoleErrors.length > 0) {
  for (const line of result.consoleErrors.slice(0, 10)) console.log(`   ✗ ${line}`);
  problems.push(`控制台报错 ${result.consoleErrors.length} 条`);
} else {
  console.log('   没有控制台报错，也没有未捕获异常。');
}

if (problems.length > 0) {
  console.error(`\n界面冒烟未通过：\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log('\n界面冒烟通过。');
