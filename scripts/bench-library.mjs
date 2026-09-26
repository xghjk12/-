#!/usr/bin/env node
/**
 * 曲库规模基准（`pnpm bench [数量]`）。
 *
 * 为什么需要它：`docs/技术方案.md` 6.2 的性能预算（首次扫描 < 30s、二次打开 < 500ms、
 * 3000 首只读文件头…）在实现完成后**没有任何一条在真实规模上验证过**。
 * 没有实测数字，优化就是猜。
 *
 * 它跑的是真实浏览器 + 真实文件，两条路都不能省：
 *  - 真实文件：要量的正是"每个文件取一次 size/mtime"这段 I/O，假对象量不出来
 *  - 真实浏览器：File System Access API、IndexedDB、布局与虚拟化都只有浏览器里才有
 *
 * 量四个数：
 *  1. 首次扫描（全部未命中）：目录遍历 + 解析 + 入库
 *  2. 二次扫描（全部命中）：只对比缓存键，不读文件内容
 *  3. 刷新后打开：纯读 IndexedDB 到列表可见
 *  4. 滚动帧率：虚拟化列表在数千行下的表现
 *
 * 与 `check:ui` 一样，它不进 `pnpm verify`（需要本机装了 Edge）。
 * 用法：pnpm bench            默认 3000 首
 *       pnpm bench 500        小规模快速验证
 *       BENCH_KEEP=1 pnpm bench  保留生成的曲库目录
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const benchDir = path.join(root, '.bench-library');
const outDir = path.join(root, 'artifacts', 'bench');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const count = Number.parseInt(process.argv[2] ?? '3000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ape': 'application/octet-stream',
  '.jpg': 'image/jpeg',
};

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

console.log(`== 1/6 准备 ${count} 首测试曲库 ==`);
if (!existsSync(path.join(benchDir, '专辑 001'))) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-bench-fixtures.mjs'), String(count)], {
    cwd: root,
    stdio: 'inherit',
  });
} else {
  console.log(`  已有 ${path.relative(root, benchDir)}，直接复用（BENCH_KEEP=1 时不会重建）`);
}

console.log('\n== 2/6 构建产物 ==');
execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });

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
console.log(`\n== 3/6 启动浏览器（本机 Edge）==\n   ${url}`);

const result = { count, firstScan: null, secondScan: null, coldOpenMs: null, scroll: null, heapMB: null };
let browser;

/**
 * 等扫描结束。
 *
 * 必须用 runId 区分轮次：`scan.active` 初始就是 false，直接等 "不活跃" 会在扫描开始前
 * 立刻返回，量出一堆 0。所以先记下当前轮次，再等"轮次变了且已经停下"。
 */
async function waitForScan(page, previousRunId) {
  await page.waitForFunction(
    (before) => {
      const scan = window.__qingyinTest.scan();
      if (!scan || scan.runId <= before) return false;
      // 歌词认领也算扫描的一部分，必须等它结束
      return scan.active === false && scan.phase !== 'listing' && scan.phase !== 'parsing' && scan.phase !== 'lyrics';
    },
    previousRunId,
    { timeout: 15 * 60_000 },
  );
  return page.evaluate(() => window.__qingyinTest.scan());
}

/** 把生成的曲库通过 webkitdirectory 输入交给页面（真实 FileList，不走任何测试后门）。 */
async function importLibrary(page) {
  // 输入是 hidden 的，setInputFiles 需要它可见可操作
  await page.evaluate(() => {
    const input = document.querySelector('input[webkitdirectory]');
    if (input) input.removeAttribute('hidden');
  });
  await page.setInputFiles('input[webkitdirectory]', benchDir);
}

try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('#selfTestResult table', { timeout: 60_000 });

  console.log('\n== 4/6 首次扫描（全部未命中）==');
  const runIdBeforeFirst = await page.evaluate(() => window.__qingyinTest.scan().runId);
  const firstStart = Date.now();
  await importLibrary(page);
  result.firstScan = await waitForScan(page, runIdBeforeFirst);
  const firstWallMs = Date.now() - firstStart;
  console.log(
    `   ${result.firstScan.total} 首：遍历 ${result.firstScan.listingMs}ms + 扫描 ` +
      `${result.firstScan.elapsedMs}ms（含解析 ${result.firstScan.parsed}、失败 ${result.firstScan.failed}）；` +
      `实际读取 ${mb(result.firstScan.bytesRead)}；墙钟 ${(firstWallMs / 1000).toFixed(1)}s`,
  );
  const t = result.firstScan.timing;
  console.log(
    `   分项：读目录清单 ${t.listFilesMs}ms、读元数据缓存 ${t.cachedTracksMs}ms、` +
      `列出来源 ${t.sourceListMs}ms、逐文件处理 ${t.loopMs}ms、清理 ${t.cleanupMs}ms`,
  );

  result.heapMB = await page.evaluate(() =>
    performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null,
  );

  // 歌词认领是否真的发生了：抽查第一首曲目的记录
  const lyricProbe = await page.evaluate(async () => {
    const paths = window.__qingyinTest.tracks();
    const first = paths[0];
    const record = first ? await window.__qingyinTest.readLyrics(first) : null;
    const files = await window.__qingyinTest.lyricFiles();
    return {
      first,
      hasLyrics: Boolean(record),
      source: record?.source ?? null,
      text: record?.text?.slice(0, 30) ?? null,
      lyricFiles: files,
    };
  });
  console.log(
    `   歌词抽查：音频 ${lyricProbe.lyricFiles.audioCount} 首、歌词 ${lyricProbe.lyricFiles.count} 个` +
      `\n     歌词清单（前 12）：${lyricProbe.lyricFiles.sample.slice(0, 12).join(' | ') || '（空）'}` +
      `\n     ${lyricProbe.first} → ${lyricProbe.hasLyrics ? `${lyricProbe.source}「${lyricProbe.text?.split('\\n')[0]}…」` : '没有歌词记录'}` +
      `\n     认领结果：${JSON.stringify(result.firstScan.lyricStats ?? null)}`,
  );

  console.log('\n== 5/6 二次扫描（应全部命中缓存）==');
  const runIdBeforeSecond = await page.evaluate(() => window.__qingyinTest.scan().runId);
  await importLibrary(page);
  result.secondScan = await waitForScan(page, runIdBeforeSecond);
  console.log(
    `   缓存命中 ${result.secondScan.reused}、新解析 ${result.secondScan.parsed}；` +
      `遍历 ${result.secondScan.listingMs}ms + 扫描 ${result.secondScan.elapsedMs}ms`,
  );
  const t2 = result.secondScan.timing;
  console.log(
    `   分项：读目录清单 ${t2.listFilesMs}ms、读元数据缓存 ${t2.cachedTracksMs}ms、` +
      `列出来源 ${t2.sourceListMs}ms、逐文件处理 ${t2.loopMs}ms、清理 ${t2.cleanupMs}ms`,
  );
  console.log(`   歌词认领（单独一步）：${result.secondScan.lyricSyncMs}ms ${JSON.stringify(result.secondScan.lyricStats ?? null)}`);

  console.log('\n== 6/6 刷新后打开与滚动 ==');
  const rowsBefore = await page.locator('.row').count();
  const reloadStart = Date.now();
  await page.reload({ waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('.row', { timeout: 60_000 });
  result.coldOpenMs = Date.now() - reloadStart;
  const afterReload = await page.evaluate(() => ({
    tracks: window.__qingyinTest.tracks().length,
    scan: window.__qingyinTest.scan(),
    rows: document.querySelectorAll('.row').length,
  }));
  console.log(
    `   刷新到列表可见 ${result.coldOpenMs}ms（缓存 ${afterReload.tracks} 首、扫描阶段 ${afterReload.scan.phase}）`,
  );

  // 滚动帧率：用 rAF 连续滚到底，统计帧数与耗时
  result.scroll = await page.evaluate(async () => {
    const scroller = document.querySelector('.table-scroll');
    if (!scroller) return null;
    const max = scroller.scrollHeight - scroller.clientHeight;
    let frames = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const step = () => {
        frames += 1;
        scroller.scrollTop = Math.min(max, scroller.scrollTop + max / 60);
        if (scroller.scrollTop >= max - 1 || frames > 240) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return {
      frames,
      ms: performance.now() - start,
      renderedRows: document.querySelectorAll('.row').length,
      totalRows: max,
      fps: (frames / (performance.now() - start)) * 1000,
    };
  });
  if (result.scroll) {
    console.log(
      `   滚动 ${result.scroll.frames} 帧 / ${result.scroll.ms.toFixed(0)}ms ≈ ${result.scroll.fps.toFixed(1)} fps；` +
        `虚拟化后 DOM 里始终只有 ${result.scroll.renderedRows} 行`,
    );
  }

  result.consoleErrors = consoleErrors;
  result.rowsBeforeReload = rowsBefore;
  result.afterReload = afterReload;

  if (consoleErrors.length > 0) {
    console.log(`\n   控制台报错 ${consoleErrors.length} 条：`);
    for (const line of consoleErrors.slice(0, 5)) console.log(`     ✗ ${line}`);
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`\n   结果已写入 ${path.relative(root, path.join(outDir, 'result.json'))}`);
} catch (error) {
  console.error(`\n基准未跑完：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}

console.log('\n== 汇总 ==');
if (result.firstScan) {
  const firstTotal = result.firstScan.listingMs + result.firstScan.elapsedMs;
  console.log(
    [
      `曲库规模        ${result.count} 首`,
      `首次扫描        ${(firstTotal / 1000).toFixed(1)}s（遍历 ${result.firstScan.listingMs}ms + 解析入库 ${result.firstScan.elapsedMs}ms）`,
      `实际读取        ${mb(result.firstScan.bytesRead)}`,
      `二次扫描        ${result.secondScan ? result.secondScan.listingMs + result.secondScan.elapsedMs : '-'}ms（命中 ${result.secondScan?.reused ?? '-'}）`,
      `歌词认领        ${result.secondScan?.lyricSyncMs ?? '-'}ms`,
      `刷新到可见      ${result.coldOpenMs}ms`,
      `滚动            ${result.scroll ? `${result.scroll.fps.toFixed(1)} fps` : '-'}`,
      `JS 堆占用       ${result.heapMB ?? '-'}MB`,
    ].join('\n'),
  );
}

if (!process.env.BENCH_KEEP) {
  await rm(benchDir, { recursive: true, force: true });
  console.log(`\n（已删除 ${path.relative(root, benchDir)}；设 BENCH_KEEP=1 可保留）`);
}
