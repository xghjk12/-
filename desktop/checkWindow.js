'use strict';

const path = require('node:path');

/**
 * 用 Playwright 驱动**真正的桌面端入口**（desktop/main.js），断言窗口里渲染出了曲库列表。
 *
 * 为什么单独一个脚本：
 * probe.js 走的是 `--probe` 分支（探针入口），它证明的是 origin/持久性；
 * 这个脚本证明的是"用户照着 README 敲那条命令，窗口里真的有曲库"——验收要的是后者。
 * 同时它也把验证阶段（t3）要用的技术路线先跑通了一遍：
 * playwright-core 的 `_electron.launch()` 能直接驱动本机的 Electron，不需要下载 Chromium。
 *
 *   node desktop/checkWindow.js
 *
 * 前置：已经跑过一次 probe 或手动导入过曲库（IndexedDB 里有数据），否则列表是空的、
 * 会看到空状态界面（这也是合法的，脚本会分别报告）。
 */

const { _electron } = require('playwright-core');
const electronPath = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'desktop');

async function main() {
  const env = { ...process.env };
  // DSH 的终端会把这个变量传给子进程，带着它 electron.exe 会退化成纯 Node（见 README 的环境坑）
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`electron: ${electronPath}`);
  console.log(`app dir : ${desktopDir}`);

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, '--no-sandbox'],
    cwd: repoRoot,
    env,
    timeout: 60000,
  });

  const problems = [];
  try {
    const win = await app.firstWindow({ timeout: 60000 });
    await win.waitForLoadState('domcontentloaded');
    // React 挂载 + boot() 读 IndexedDB 都是异步的：等界面真的长出内容再断言，
    // 否则量到的是"还没渲染完"的空 DOM（这个坑第一遍就踩了）
    await win.waitForSelector('.row, .empty', { timeout: 60000 });

    const facts = await win.evaluate(() => ({
      href: location.href,
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      title: document.title,
      rows: document.querySelectorAll('.row').length,
      titles: Array.from(document.querySelectorAll('.row .title-main')).map((node) => node.textContent.trim()),
      emptyState: Boolean(document.querySelector('.empty')),
      emptyStateHeading: document.querySelector('.empty h2') ? document.querySelector('.empty h2').textContent.trim() : '',
      sidebarRoot: document.querySelector('.side-root') ? document.querySelector('.side-root').textContent.trim() : '',
      hasTestHooks: typeof window.__qingyinTest !== 'undefined',
      hasDesktopBridge: typeof window.qingyinDesktop !== 'undefined',
      databases: null,
    }));

    try {
      facts.databases = await win.evaluate(async () => (await indexedDB.databases()).map((item) => `${item.name}@v${item.version}`));
    } catch (error) {
      facts.databases = `ERR ${error.message}`;
    }

    console.log('\n== 窗口里的事实 ==');
    for (const [key, value] of Object.entries(facts)) {
      console.log(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }

    if (!facts.origin.startsWith('http://127.0.0.1:')) {
      problems.push(`origin 不是固定的回环地址：${facts.origin}`);
    }
    if (!facts.isSecureContext) problems.push('页面不是安全上下文（IndexedDB 会受限）');
    if (!facts.hasDesktopBridge) problems.push('preload 没有暴露 window.qingyinDesktop');
    if (facts.hasTestHooks) problems.push('正式入口不该有 __qingyinTest（那是 ?selftest=1 才装的）');

    if (facts.rows > 0) {
      console.log(`\n✓ 曲库列表渲染出 ${facts.rows} 行：${facts.titles.join('、')}`);
    } else if (facts.emptyState) {
      console.log(`\n△ 列表为空，界面停在空状态：「${facts.emptyStateHeading}」`);
      console.log('  （这是"还没导入过曲库"的正常表现；要看到列表，请先跑 node desktop/runProbe.js 导入内置样本）');
    } else {
      problems.push('既没有列表行，也没有空状态：界面可能没挂载成功');
    }

    const shotPath = path.join(repoRoot, 'artifacts', 'desktop', 'window-main.png');
    await win.screenshot({ path: shotPath });
    console.log(`\n截图：${path.relative(repoRoot, shotPath)}`);
  } catch (error) {
    problems.push(`窗口检查没跑完：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await app.close();
  }

  if (problems.length > 0) {
    console.error(`\n窗口检查未通过：\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n窗口检查通过：壳能开窗，加载的是固定 origin，界面按预期渲染。');
}

main().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
