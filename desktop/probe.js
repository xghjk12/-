'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const constants = require('./constants.js');
const { installAppProtocolHandler, registerAppSchemePrivileges } = require('./appProtocol.js');
const { installDesktopIpc } = require('./mainIpc.js');
const { createStaticServer } = require('./staticServer.js');
const { pinUserData } = require('./userData.js');
const { createMainWindow } = require('./window.js');

/**
 * origin 持久性实验的探针（不是产品代码）。
 *
 * 它要回答的问题只有一个：**换掉整个进程之后，这个 origin 上的 IndexedDB 还在不在。**
 * 所以它必须被完整地跑两次（write / read），中间进程真的退出：
 *
 *   node desktop/runProbe.cjs
 *
 * 或者直接手动：
 *   node_modules\electron\dist\electron.exe desktop/probe.js --phase=write --origin=http
 *   node_modules\electron\dist\electron.exe desktop/probe.js --phase=read  --origin=http
 *
 * 顺带量一批"实现阶段要用到、现在不知道就得猜"的环境事实：
 * 版本号从哪来、userData 落在哪、Service Worker 在不在、showDirectoryPicker 有没有、
 * Uint8Array 能不能穿过 contextBridge。
 */

// ================= 参数 =================

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (match) out[match[1]] = match[2] === undefined ? '1' : match[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const phase = args.phase === 'read' ? 'read' : 'write';
const originMode = args.origin === 'app' ? 'app' : 'http';
const loadFixtures = args.fixtures !== '0';
const showWindow = args.show !== '0';
const timeoutMs = Number(args.timeout ?? 180000);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, constants.DIST_DIRNAME);
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');
const reportPath = args.out
  ? path.resolve(args.out)
  : path.join(artifactsDir, `probe-${originMode}-${phase}.json`);
const shotPath = args.shot
  ? path.resolve(args.shot)
  : path.join(artifactsDir, `probe-${originMode}-${phase}.png`);

// ================= ready 之前必须做的事 =================

// userData 必须在 ready 之前钉死，而且**不能**在钉之前调 app.getPath('userData')：
// 本机那条默认路径（%APPDATA%）electron.exe 写不进去，会直接把进程崩掉。详见 userData.js。
const userDataChoice = pinUserData();
// 无人值守跑，排除显卡差异；截图走软件合成一样能拿到
app.disableHardwareAcceleration();
// 方案 b 的 scheme 特权必须在 ready 之前注册，ready 之后调用无效
if (originMode === 'app') registerAppSchemePrivileges();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================= 渲染进程里执行的探针 =================
// 这些函数会被 toString() 之后丢进 executeJavaScript，
// 所以必须自包含：不能引用 Node 作用域里的任何东西。

function probeWaitSelfTest() {
  const panel = document.querySelector('#selfTestResult');
  const verdict = panel ? panel.dataset.verdict : undefined;
  return {
    ok: Boolean(panel && verdict),
    verdict: verdict ?? null,
    heading: panel ? (panel.querySelector('h2') ? panel.querySelector('h2').textContent.trim() : '') : '',
    rows: document.querySelectorAll('.row').length,
  };
}

function probeWaitRows(minimum) {
  const rows = document.querySelectorAll('.row').length;
  return { ok: rows >= minimum, rows };
}

function probeReadEnv() {
  return (async () => {
    const out = {
      href: location.href,
      origin: location.origin,
      protocol: location.protocol,
      host: location.host,
      isSecureContext: window.isSecureContext,
      userAgent: navigator.userAgent,
      typeofShowDirectoryPicker: typeof window.showDirectoryPicker,
      typeofIndexedDb: typeof window.indexedDB,
      appRows: document.querySelectorAll('.row').length,
      databases: null,
      localStorageWorks: null,
      storagePersisted: null,
      storageEstimate: null,
      serviceWorker: { supported: 'serviceWorker' in navigator, registrations: null, controlled: null },
      bridgeInfo: null,
      bridgeEchoBytes: null,
      selfTest: null,
    };

    try {
      localStorage.setItem('__qingyin_probe__', '1');
      out.localStorageWorks = localStorage.getItem('__qingyin_probe__') === '1';
      localStorage.removeItem('__qingyin_probe__');
    } catch (error) {
      out.localStorageWorks = `ERR ${error.message}`;
    }

    try {
      const list = await indexedDB.databases();
      out.databases = list.map((entry) => ({ name: entry.name, version: entry.version }));
    } catch (error) {
      out.databases = `ERR ${error.message}`;
    }

    try {
      out.storagePersisted = await navigator.storage.persisted();
    } catch (error) {
      out.storagePersisted = `ERR ${error.message}`;
    }

    try {
      const estimate = await navigator.storage.estimate();
      out.storageEstimate = { usage: estimate.usage, quota: estimate.quota };
    } catch (error) {
      out.storageEstimate = `ERR ${error.message}`;
    }

    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      out.serviceWorker.registrations = registrations.length;
      out.serviceWorker.scopes = registrations.map((item) => item.scope);
      out.serviceWorker.controlled = Boolean(navigator.serviceWorker.controller);
    } catch (error) {
      out.serviceWorker.registrations = `ERR ${error.message}`;
    }

    try {
      out.bridgeInfo = window.qingyinDesktop ? await window.qingyinDesktop.info() : 'preload 没有暴露 qingyinDesktop';
    } catch (error) {
      out.bridgeInfo = `ERR ${error.message}`;
    }

    // fs 桥的前置验证：二进制能不能原样穿过 contextBridge
    try {
      const bytes = window.qingyinDesktop ? await window.qingyinDesktop.echoBytes(4096) : null;
      out.bridgeEchoBytes = bytes
        ? {
            ctor: bytes.constructor ? bytes.constructor.name : 'unknown',
            isUint8Array: bytes instanceof Uint8Array,
            isArray: Array.isArray(bytes),
            length: bytes.length,
            byteLength: bytes.byteLength,
            head: Array.from(bytes.slice ? bytes.slice(0, 4) : bytes).slice(0, 4),
            tail: Array.from(bytes.slice ? bytes.slice(-2) : []).slice(0, 2),
          }
        : 'no bridge';
    } catch (error) {
      out.bridgeEchoBytes = `ERR ${error.message}`;
    }

    const panel = document.querySelector('#selfTestResult');
    if (panel) {
      out.selfTest = {
        verdict: panel.dataset.verdict ?? null,
        heading: panel.querySelector('h2') ? panel.querySelector('h2').textContent.trim() : '',
        rows: Array.from(panel.querySelectorAll('table tr')).slice(1).map((row) => {
          const cells = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim());
          return { label: cells[0], actual: cells[1], expected: cells[2], verdict: cells[3] };
        }),
      };
    }

    return out;
  })();
}

/**
 * 读写探针库。
 *
 * 刻意用一个**独立的库**（`qingyin-desktop-probe`），不去碰应用自己的 `qingyin-player`：
 * 应用那个库是 v2 带 7 个仓库，外面用 `indexedDB.open(name, 2)` 打开而 upgrade 回调什么都不做的话，
 * 会造出一个"版本号对但没有仓库"的库，应用再打开时 upgrade 不会触发，直接崩。
 * 应用侧的数据改从 `window.__qingyinTest` 读（走的是应用自己的存储实例）。
 */
function probeRecord(action, token) {
  return (async () => {
    const DB_NAME = 'qingyin-desktop-probe';
    const STORE = 'probe';
    const KEY = 'origin';

    function openDb() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('open blocked'));
      });
    }

    function getRecord(db) {
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
        request.onerror = () => reject(request.error);
      });
    }

    const startedAt = Date.now();
    let db;
    try {
      db = await openDb();
      const before = await getRecord(db);
      let written = null;

      if (action === 'write') {
        written = {
          id: KEY,
          token,
          writtenAt: new Date().toISOString(),
          origin: location.origin,
          href: location.href,
          userAgent: navigator.userAgent,
        };
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(written, KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
        });
      }

      const after = action === 'write' ? await getRecord(db) : before;
      const count = await new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      return { ok: true, dbName: DB_NAME, store: STORE, key: KEY, action, before, written, after, count, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        dbName: DB_NAME,
        action,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      if (db) db.close();
    }
  })();
}

function probeReadApp() {
  return (async () => {
    const hooks = window.__qingyinTest;
    if (!hooks) return { ok: false, error: '页面里没有 __qingyinTest（URL 上少了 ?selftest=1）' };
    let persisted = null;
    try {
      persisted = await hooks.readPersisted();
    } catch (error) {
      persisted = `ERR ${error.message}`;
    }
    return {
      ok: true,
      domRows: document.querySelectorAll('.row').length,
      domTitles: Array.from(document.querySelectorAll('.row .title-main')).map((node) => node.textContent.trim()),
      trackPaths: hooks.tracks(),
      scan: hooks.scan(),
      state: hooks.state(),
      persisted,
    };
  })();
}

function probeLoadFixtures() {
  return (async () => {
    const hooks = window.__qingyinTest;
    if (!hooks) return { ok: false, error: '页面里没有 __qingyinTest（URL 上少了 ?selftest=1）' };
    const count = await hooks.loadFixtureLibrary();
    return { ok: true, count, trackPaths: hooks.tracks(), scan: hooks.scan(), domRows: document.querySelectorAll('.row').length };
  })();
}

// ================= 主进程侧的执行框架 =================

async function evaluate(win, fn, ...callArgs) {
  const source = `(${fn.toString()})(${callArgs.map((value) => JSON.stringify(value)).join(', ')})`;
  return win.webContents.executeJavaScript(source, true);
}

async function waitFor(win, fn, callArgs, label, deadline) {
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(win, fn, ...callArgs);
      if (last && last.ok) return last;
    } catch (error) {
      last = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(300);
  }
  throw new Error(`等待超时：${label}；最后一次结果 ${JSON.stringify(last)}`);
}

/** 列出 userData 下的 IndexedDB 目录：origin 是否真的落到磁盘上的物理证据。 */
async function inspectUserData() {
  const userData = app.getPath('userData');
  const result = { userData, exists: fs.existsSync(userData), indexedDb: [], local: [], topLevel: [] };
  try {
    result.topLevel = (await fsp.readdir(userData)).slice(0, 60);
  } catch (error) {
    result.topLevelError = error.message;
  }
  for (const sub of ['IndexedDB', 'Local Storage']) {
    const dir = path.join(userData, sub);
    const bucket = sub === 'IndexedDB' ? result.indexedDb : result.local;
    try {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        let bytes = 0;
        if (entry.isDirectory()) {
          const walk = async (current) => {
            for (const item of await fsp.readdir(current, { withFileTypes: true })) {
              const itemPath = path.join(current, item.name);
              if (item.isDirectory()) await walk(itemPath);
              else bytes += (await fsp.stat(itemPath)).size;
            }
          };
          try {
            await walk(absolute);
          } catch {
            bytes = -1;
          }
        } else {
          bytes = (await fsp.stat(absolute)).size;
        }
        bucket.push({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file', bytes });
      }
    } catch (error) {
      bucket.push({ name: `<读不到 ${sub}>`, kind: 'error', bytes: 0, error: error.message });
    }
  }
  return result;
}

async function run() {
  const startedAt = new Date();
  const report = {
    phase,
    originMode,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    argv: process.argv.slice(2),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      userDataRequested: userDataChoice.requested,
      userDataFellBack: userDataChoice.fellBack,
      userDataReason: userDataChoice.reason ?? null,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    console: { errors: [], warnings: [], messages: [] },
    failures: [],
  };

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`找不到 ${path.join(distDir, 'index.html')}：先跑 vite build`);
  }
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });

  let staticServer = null;
  let url;

  if (originMode === 'http') {
    staticServer = createStaticServer({ root: distDir });
    try {
      await staticServer.listen();
    } catch (error) {
      throw new Error(`静态服务起不来（端口 ${constants.PORT}）：${error.code ?? ''} ${error.message}`);
    }
    url = `${staticServer.origin}/?selftest=1`;
    report.server = { origin: staticServer.origin, port: staticServer.port, token: staticServer.token };
  } else {
    installAppProtocolHandler(distDir);
    url = `${constants.APP_ORIGIN}/index.html?selftest=1`;
    report.server = { scheme: constants.APP_SCHEME, host: constants.APP_HOST };
  }
  report.url = url;

  installDesktopIpc({
    origin: originMode === 'http' ? staticServer.origin : constants.APP_ORIGIN,
    port: originMode === 'http' ? staticServer.port : null,
    token: staticServer ? staticServer.token : null,
    startedAt: startedAt.toISOString(),
  });

  const win = createMainWindow({ distDir, show: showWindow });
  const consoleSink = report.console;
  win.webContents.on('console-message', (...payload) => {
    // 新旧 Electron 的签名不同：新版给一个带 level/message 的事件对象，旧版给一串位置参数
    const first = payload[0];
    let level;
    let message;
    let source;
    if (first && typeof first === 'object' && 'message' in first) {
      level = String(first.level);
      message = first.message;
      source = first.sourceId ?? first.frameId ?? '';
    } else {
      level = String(payload[1]);
      message = payload[2];
      source = payload[4] ?? '';
    }
    const line = `${level}: ${message}${source ? ` (${source})` : ''}`;
    consoleSink.messages.push(line);
    const text = String(message ?? '');
    const isError = level === '3' || level === 'error' || /\berror\b|Uncaught|Failed/i.test(text);
    if (isError) consoleSink.errors.push(line);
    else if (level === '2' || level === 'warning') consoleSink.warnings.push(line);
  });
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    consoleSink.errors.push(`did-fail-load ${code} ${description} ${validatedUrl}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    consoleSink.errors.push(`render-process-gone ${JSON.stringify(details)}`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    consoleSink.errors.push(`preload-error ${preloadPath}: ${error && error.message}`);
  });

  const deadline = Date.now() + timeoutMs;

  try {
    await win.loadURL(url);
    report.loadedAt = new Date().toISOString();

    // 1) 等内置自检跑完（它会真解析 flac/mp3，是"渲染进程真的活着"的硬证据）
    const selfTest = await waitFor(win, probeWaitSelfTest, [], '内置自检出结果', deadline);
    report.selfTestGate = selfTest;

    // 2) 环境事实（含 contextBridge 二进制通道）
    report.env = await evaluate(win, probeReadEnv);

    // 3) 探针库：先读（write 阶段第一次读应该是 null），再按需写
    const token = args.token || `probe-${phase}-${startedAt.getTime()}`;
    report.token = token;
    report.probeBefore = await evaluate(win, probeRecord, phase === 'write' ? 'write' : 'read', token);

    // 4) 应用自己的数据（走 __qingyinTest，不碰应用的库）
    report.appDataBefore = await evaluate(win, probeReadApp);

    if (phase === 'write' && loadFixtures) {
      report.fixtureImport = await evaluate(win, probeLoadFixtures);
      report.rowsAfterImport = await waitFor(win, probeWaitRows, [1], '列表渲染出至少 1 行', deadline);
      report.appDataAfterImport = await evaluate(win, probeReadApp);
    }

    // 5) 截图 + 物理落盘证据
    try {
      const image = await win.webContents.capturePage();
      const buffer = image.toPNG();
      await fsp.writeFile(shotPath, buffer);
      report.screenshot = path.relative(repoRoot, shotPath);
      report.screenshotBytes = buffer.length;
    } catch (error) {
      report.screenshotError = error.message;
    }

    report.userData = await inspectUserData();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
  } catch (error) {
    report.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    try {
      report.userData = await inspectUserData();
    } catch {
      /* 尽力而为 */
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
  } finally {
    report.console.messageCount = consoleSink.messages.length;
    if (consoleSink.messages.length > 40) consoleSink.messages = consoleSink.messages.slice(0, 40);
    if (report.fatal) report.failures.push(report.fatal);
    if (consoleSink.errors.length > 0) report.failures.push(`控制台报错 ${consoleSink.errors.length} 条`);

    const json = JSON.stringify(report, null, 2);
    await fsp.writeFile(reportPath, json, 'utf8');
    // stdout 在管道上是异步的：等回调，别在 flush 之前退出（驱动脚本还要解析这段 JSON）
    await new Promise((resolve) => {
      process.stdout.write(`===QINGYIN-PROBE-BEGIN===\n${json}\n===QINGYIN-PROBE-END===\n`, resolve);
    });

    process.exitCode = report.fatal ? 2 : 0;
    if (!win.isDestroyed()) win.destroy();
    if (staticServer) await staticServer.close();
    // 走正常退出流程（而不是 app.exit）：IndexedDB 的写入要在 Chromium 的存储线程上真正提交，
    // 硬退会把这个实验变成"连崩溃都能扛住吗"，那不是我们要量的东西。
    const forceQuit = setTimeout(() => app.exit(process.exitCode), 8000);
    forceQuit.unref?.();
    app.quit();
  }
}

app.whenReady().then(() => {
  void run().catch((error) => {
    process.stdout.write(`===QINGYIN-PROBE-BEGIN===\n${JSON.stringify({ phase, originMode, fatal: String(error && error.stack) }, null, 2)}\n===QINGYIN-PROBE-END===\n`);
    app.exit(3);
  });
});
