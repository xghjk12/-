'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * origin 持久性实验的驱动脚本。
 *
 * 它做的事很朴素：把 Electron **完整地跑两次**（中间进程真的退出），比较两次的读数。
 * 之所以要一个驱动脚本而不是让我手点两遍：这个结论要能被任何人一条命令复现。
 *
 *   node desktop/runProbe.js            # 方案 a（http://127.0.0.1:53140）
 *   node desktop/runProbe.js --origin=app   # 方案 b（app://qingyin）对照
 *   node desktop/runProbe.js --both     # 两个都跑
 *
 * 退出码：0 = 持久化成立，1 = 不成立或跑挂了。
 */

// 在普通 Node 里 require('electron') 得到的是可执行文件路径（这是 electron 包的设计）
const electronPath = require('electron');
const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop');

/**
 * 干净的子进程环境。
 *
 * **必须删掉 `ELECTRON_RUN_AS_NODE`**：本机是在 DSH（本身就是 Electron 应用）的终端里跑命令，
 * 它会把这个变量设成 1 并传给所有子进程。带着它启动 electron.exe，Electron 会退化成"纯 Node"——
 * `require('electron').app` 是 undefined，一开头就 TypeError 崩掉，看起来像是代码写错了，
 * 其实是环境变量在作怪。这个坑对实现阶段与 Playwright 驱动 Electron 的验证阶段同样存在。
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (match) out[match[1]] = match[2] === undefined ? '1' : match[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const modes = args.both ? ['http', 'app'] : [args.origin === 'app' ? 'app' : 'http'];

/**
 * 传给 Electron 的启动参数。
 *
 * 默认带 `--no-sandbox`，因为**这台机器上不带就起不来**（Chromium 在跑到我们的代码之前
 * 就 EXCEPTION_BREAKPOINT）。换机器时可以用 `--electron-flags=` 传空来验证沙箱能不能开。
 */
const launchFlags = args['electron-flags'] === undefined
  ? ['--no-sandbox']
  : args['electron-flags'].split(',').filter(Boolean);

function runProbe(phase, origin, token) {
  const out = path.join(artifactsDir, `probe-${origin}-${phase}.json`);
  const shot = path.join(artifactsDir, `probe-${origin}-${phase}.png`);
  const childArgs = [
    // 用**目录**方式启动（不是 desktop/probe.js）：这样 app.getName()/getVersion()
    // 读的是 desktop/package.json，而不是退化成 "Electron" / 44.9.1
    path.join(repoRoot, 'desktop'),
    '--probe',
    // 本机必须带 --no-sandbox：不带的话 Chromium 在跑到我们的 JS 之前就
    // EXCEPTION_BREAKPOINT 秒崩（app.commandLine.appendSwitch 太晚，救不回来）。详见 README。
    ...launchFlags,
    `--phase=${phase}`,
    `--origin=${origin}`,
    `--out=${out}`,
    `--shot=${shot}`,
  ];
  if (token) childArgs.push(`--token=${token}`);

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electronPath, childArgs, {
      cwd: repoRoot,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 6 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(killer);
      let report = null;
      const match = /===QINGYIN-PROBE-BEGIN===\s*([\s\S]*?)\s*===QINGYIN-PROBE-END===/.exec(stdout);
      if (match) {
        try {
          report = JSON.parse(match[1]);
        } catch {
          report = null;
        }
      }
      // stdout 万一被截断，还有落盘的报告兜底
      if (!report && fs.existsSync(out)) {
        try {
          report = JSON.parse(fs.readFileSync(out, 'utf8'));
        } catch {
          report = null;
        }
      }
      resolve({ phase, origin, code, durationMs: Date.now() - started, report, stdout, stderr, reportPath: out });
    });
  });
}

function summarize(run) {
  const report = run.report;
  console.log(`\n---- ${run.origin} / ${run.phase} ----`);
  console.log(`  退出码 ${run.code}，耗时 ${(run.durationMs / 1000).toFixed(1)}s，报告 ${path.relative(repoRoot, run.reportPath)}`);
  if (!report) {
    console.log('  ✗ 没拿到报告。stderr 尾部：');
    console.log(run.stderr.split(/\r?\n/).slice(-15).map((line) => `    ${line}`).join('\n'));
    return;
  }
  console.log(`  url            ${report.url}`);
  console.log(`  origin         ${report.env ? report.env.origin : '(无)'}`);
  console.log(`  secureContext  ${report.env ? report.env.isSecureContext : '(无)'}`);
  console.log(`  app            ${report.app.name} v${report.app.version}（electron ${report.app.electron} / chrome ${report.app.chrome} / node ${report.app.node}）`);
  console.log(`  userData       ${report.app.userData}${report.app.userDataFellBack ? `（备用目录；原本要用 ${report.app.userDataRequested}）` : ''}`);
  console.log(`  selfTest       ${report.selfTestGate ? report.selfTestGate.verdict : '(无)'} ${report.env && report.env.selfTest ? report.env.selfTest.heading : ''}`);
  const record = report.probeBefore;
  if (record) {
    console.log(`  探针库 ${record.dbName}/${record.key}`);
    console.log(`    打开前读到  ${record.before ? `${record.before.token} @ ${record.before.writtenAt}` : 'null（库里没有记录）'}`);
    if (record.written) console.log(`    本次写入    ${record.written.token} @ ${record.writtenAt}`);
    console.log(`    操作后读到  ${record.after ? `${record.after.token} @ ${record.after.writtenAt}` : 'null'}（记录数 ${record.count}）`);
    if (!record.ok) console.log(`    ✗ 失败：${record.error}`);
  }
  const appData = report.appDataAfterImport ?? report.appDataBefore;
  if (appData && appData.ok) {
    console.log(`  应用数据 曲目 ${appData.trackPaths.length} 首，列表 ${appData.domRows} 行：${appData.domTitles.join('、')}`);
    console.log(`    扫描 ${appData.scan ? `${appData.scan.phase} parsed=${appData.scan.parsed} reused=${appData.scan.reused}` : '(无)'}`);
  } else if (appData) {
    console.log(`  应用数据读取失败：${appData.error}`);
  }
  if (report.userData) {
    console.log(`  userData/IndexedDB：${report.userData.indexedDb.map((entry) => `${entry.name}(${entry.bytes}B)`).join('、') || '(空)'}`);
  }
  if (report.env) {
    console.log(`  databases      ${JSON.stringify(report.env.databases)}`);
    console.log(`  storage.persisted ${JSON.stringify(report.env.storagePersisted)}`);
    console.log(`  serviceWorker  ${JSON.stringify(report.env.serviceWorker)}`);
    console.log(`  showDirectoryPicker ${report.env.typeofShowDirectoryPicker}`);
    console.log(`  contextBridge 二进制 ${JSON.stringify(report.env.bridgeEchoBytes)}`);
  }
  if (report.console && report.console.errors.length > 0) {
    console.log(`  控制台报错 ${report.console.errors.length} 条：`);
    for (const line of report.console.errors.slice(0, 8)) console.log(`    ${line}`);
  } else {
    console.log(`  控制台报错 0 条（共 ${report.console ? report.console.messageCount : 0} 条消息）`);
  }
  if (report.screenshot) console.log(`  截图         ${report.screenshot}`);
  if (report.fatal) console.log(`  ✗ 致命错误：${report.fatal}`);
}

function compare(origin, writeRun, readRun) {
  const problems = [];
  const write = writeRun.report;
  const read = readRun.report;
  if (!write || !read) {
    problems.push(`${origin}：有一次运行没拿到报告，无法比较`);
    return problems;
  }

  const writtenToken = write.probeBefore && write.probeBefore.written ? write.probeBefore.written.token : null;
  const readToken = read.probeBefore && read.probeBefore.before ? read.probeBefore.before.token : null;
  if (!writtenToken) problems.push(`${origin}：写入阶段没有写进探针记录`);
  if (read.probeBefore && !read.probeBefore.ok) problems.push(`${origin}：重开后读探针库失败（${read.probeBefore.error}）`);
  if (writtenToken && readToken !== writtenToken) {
    problems.push(`${origin}：重开后读到的 token 不一致（写入 ${writtenToken}，读到 ${readToken}）`);
  }

  const imported = write.appDataAfterImport ? write.appDataAfterImport.trackPaths.length : 0;
  const restored = read.appDataBefore ? read.appDataBefore.trackPaths.length : 0;
  if (imported > 0 && restored !== imported) {
    problems.push(`${origin}：应用曲库没有跨进程恢复（写入 ${imported} 首，重开读到 ${restored} 首）`);
  }
  if (imported > 0 && read.appDataBefore && read.appDataBefore.domRows < 1) {
    problems.push(`${origin}：重开后列表没有渲染出任何行`);
  }

  if (write.env && read.env && write.env.origin !== read.env.origin) {
    problems.push(`${origin}：两次运行的 origin 不一致（${write.env.origin} → ${read.env.origin}）`);
  }

  return problems;
}

async function main() {
  console.log(`electron 可执行文件：${electronPath}`);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const allProblems = [];
  const summary = {};

  for (const mode of modes) {
    console.log(`\n================= 方案 ${mode === 'http' ? 'a（本地静态服务）' : 'b（app:// 协议）'} =================`);
    const writeRun = await runProbe('write', mode);
    summarize(writeRun);
    const token = writeRun.report && writeRun.report.token ? writeRun.report.token : undefined;

    console.log('\n  ... 进程已完全退出，2 秒后重开 ...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const readRun = await runProbe('read', mode, token);
    summarize(readRun);

    const problems = compare(mode, writeRun, readRun);
    allProblems.push(...problems);
    summary[mode] = {
      write: writeRun.report,
      read: readRun.report,
      persisted: problems.length === 0,
      problems,
    };

    console.log(`\n  >>> 方案 ${mode} 的结论：${problems.length === 0 ? '✓ 数据跨进程存活' : `✗ ${problems.join('；')}`}`);
  }

  const summaryPath = path.join(artifactsDir, 'probe-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n汇总写入 ${path.relative(repoRoot, summaryPath)}`);

  if (allProblems.length > 0) {
    console.error(`\n持久性实验未通过：\n${allProblems.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n持久性实验通过：两次运行之间进程完全退出，数据仍在。');
}

void main();
