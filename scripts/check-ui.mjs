#!/usr/bin/env node
/**
 * 最小界面冒烟：用**本机已装的 Edge（Chromium 内核）**驱动浏览器，跑一遍 M0 验证页的内置自检。
 *
 * 为什么用 Edge 而不是让 Playwright 下载 Chromium：本机已有 Edge，而 `playwright-core`
 * 本身不下载浏览器，所以这条路零下载。
 *
 * 也因此它**不进 `pnpm verify`**：它依赖「本机装了 Edge」，属于开发机上的辅助验证，
 * 不是可移植的验证链。可移植的那部分仍然是 typecheck + test + check:bundle。
 *
 * 它验证的是自动化能覆盖的部分：
 *   - 页面能真正在浏览器里跑起来（不是只看源码推断）
 *   - 内置自检（浏览器里解析真实 flac/mp3）逐项通过
 *   - 没有控制台报错 / 未捕获异常
 *   - 留一张截图，供人（或 AI）肉眼确认版面
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
const distDir = path.join(root, 'dist-m0');
const shotDir = path.join(root, 'artifacts', 'ui');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
};

console.log('== 1/4 构建产物 ==');
execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });

/** 只服务 dist-m0 下的文件，路径穿越直接拒绝。 */
function startStaticServer() {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // 验证页没有 favicon，浏览器会自动请求一次；这不是页面缺陷，别让它污染控制台断言
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
    // 端口交给系统分配，避免和 dev server（5174）撞车
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await startStaticServer();
const url = `http://127.0.0.1:${port}/`;
console.log(`== 2/4 启动浏览器（本机 Edge）==\n   ${url}`);

const problems = [];
let browser;
let result;

try {
  // channel 指向本机 Edge；playwright-core 不带浏览器，所以这里不会触发下载
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // 带上资源地址，否则「Failed to load resource」这类报错无法定位
    const { url: resourceUrl } = message.location();
    consoleErrors.push(resourceUrl ? `${message.text()} (${resourceUrl})` : message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`未捕获异常: ${error.message}`));
  page.on('requestfailed', (request) =>
    consoleErrors.push(`请求失败: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );

  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  // 页面加载后会自动跑一次内置自检，等它渲染出结果表
  await page.waitForSelector('#selfTestResult table', { timeout: 30_000 });

  result = await page.evaluate(() => {
    const heading = document.querySelector('#selfTestResult h2')?.textContent?.trim() ?? '';
    // 第 0 行是表头，跳过
    const rows = [...document.querySelectorAll('#selfTestResult table tr')]
      .slice(1)
      .map((row) => {
        const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim());
        return { label: cells[0], actual: cells[1], expected: cells[2], verdict: cells[3] };
      });
    return { heading, rows, log: document.querySelector('#log')?.textContent?.trim() ?? '' };
  });

  await mkdir(shotDir, { recursive: true });
  const shotPath = path.join(shotDir, 'm0-selfcheck.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  result.screenshot = path.relative(root, shotPath);
  result.consoleErrors = consoleErrors;
} catch (error) {
  problems.push(`浏览器冒烟未跑完：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close();
  server.close();
}

console.log('\n== 3/4 页面自检结果 ==');
if (result) {
  console.log(`   ${result.heading}`);
  for (const row of result.rows) {
    const mark = row.verdict === '通过' ? '✓' : '✗';
    console.log(`   ${mark} ${row.label.padEnd(22)} 实际 ${row.actual}  期望 ${row.expected}`);
  }
  console.log(`\n   页面日志：\n${result.log.split('\n').map((line) => `     ${line}`).join('\n')}`);
  console.log(`\n   截图：${result.screenshot}`);

  if (!result.heading.includes('全部通过')) {
    problems.push(`页面自检未全部通过：${result.heading}`);
  }
  const failed = result.rows.filter((row) => row.verdict !== '通过');
  if (failed.length > 0) {
    problems.push(`失败项：${failed.map((row) => row.label).join('、')}`);
  }
  if (result.consoleErrors.length > 0) {
    problems.push(`控制台报错 ${result.consoleErrors.length} 条`);
  }
} else {
  console.log('   （没有拿到结果，见上面的失败原因）');
}

console.log('\n== 4/4 控制台 ==');
if (result?.consoleErrors.length) {
  for (const line of result.consoleErrors) console.log(`   ✗ ${line}`);
} else if (result) {
  console.log('   没有控制台报错，也没有未捕获异常。');
}

if (problems.length > 0) {
  console.error(`\n界面冒烟未通过：\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log('\n界面冒烟通过。');
