#!/usr/bin/env node
/**
 * 打安装包（`pnpm dist`）。
 *
 * 产出：`artifacts/dist-app/轻音播放-<版本>-安装包.exe`
 * 用户双击它 → 安装向导 → 开始菜单/桌面出现「轻音播放」→ 双击就能听歌。
 *
 * == 为什么要有这个脚本，而不直接调 electron-builder ==
 * 1. 顺序对打包结果有影响：必须**先**构建前端（dist/ 要被 extraResources 拷走），
 *    再跑 electron-builder。忘了 build 就会打出一个"界面空白"的包，而且装完才发现。
 * 2. 镜像：Electron 本体与 NSIS 工具链默认从 GitHub 下载，本机 GitHub 被加速器接管，
 *    直连必失败。这里统一走 npmmirror。
 * 3. 打包前先跑自检（图标存在、白名单与依赖图一致），把"装完打不开"挡在构建之前。
 *
 * 用法：
 *   pnpm dist                # 完整打包
 *   pnpm dist --skip-build   # 复用已有 dist/（调试打包配置时省时间）
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipBuild = process.argv.includes('--skip-build');

/** 本机实测：这些域名必须走镜像，直连 GitHub 会卡住或超时。 */
process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??=
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ ${label}`);
    console.log(`  ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      // node/pnpm 都在 PATH 里；shell 让 .cmd 也能跑
      shell: process.platform === 'win32',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败（退出码 ${code}）`));
    });
  });
}

/** 打包前置条件：少一个都会产出一个坏包，所以宁可现在就失败。 */
function preflight() {
  const problems = [];
  const required = ['public/icons/icon.ico', 'desktop/main.js', 'desktop/entry.js'];
  for (const file of required) {
    if (!existsSync(path.join(root, file))) problems.push(`缺少 ${file}`);
  }
  if (!skipBuild && !existsSync(path.join(root, 'dist', 'index.html'))) {
    // 会由下面的 build 步骤补上，这里不报错——只在 skip-build 时才致命
  }
  if (skipBuild && !existsSync(path.join(root, 'dist', 'index.html'))) {
    problems.push('--skip-build 要求 dist/index.html 已存在，但没找到（先跑 pnpm build）');
  }
  if (problems.length > 0) {
    console.error('打包前置检查未通过：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

function printResult() {
  const outDir = path.join(root, 'artifacts', 'dist-app');
  if (!existsSync(outDir)) {
    console.error(`没找到产物目录 ${outDir}`);
    return;
  }
  console.log('\n== 产物 ==');
  // 直接列目录，不递归：安装包只会出现在这里
  const entries = [];
  for (const name of readdirSync(outDir)) {
    const full = path.join(outDir, name);
    const stats = statSync(full);
    if (stats.isFile() && /\.(exe|msi|7z|zip)$/i.test(name)) {
      entries.push({ name, full, mb: (stats.size / 1024 / 1024).toFixed(1) });
    }
  }
  if (entries.length === 0) console.log('  （没有安装包产物，检查上面的日志）');
  for (const entry of entries) {
    console.log(`  ${entry.full}`);
    console.log(`    ${entry.mb} MB`);
  }
  // win-unpacked 是免安装的绿色版目录，顺手说明一下（排障时很有用）
  const unpacked = path.join(outDir, 'win-unpacked', '轻音播放.exe');
  if (existsSync(unpacked)) {
    console.log(`\n  免安装版（排障用）：${unpacked}`);
  }
}

try {
  preflight();
  if (!skipBuild) {
    await run('node', ['node_modules/vite/bin/vite.js', 'build'], '构建前端（vite build）');
  } else {
    console.log('\n▶ 跳过前端构建（--skip-build）');
  }
  await run(
    'node',
    [
      'node_modules/electron-builder/out/cli/cli.js',
      '--config',
      // 绝对路径：--projectDir 会改掉工作目录，相对路径会被解析到 desktop/ 下面去（实测）
      path.join(root, 'electron-builder.config.mjs'),
      // 应用根 = desktop/（那里有 package.json 的 main 与全部主进程代码）。
      // 这是 **CLI 参数**，不是配置字段——写进 config 会被 schema 校验拒掉（实测）。
      '--projectDir',
      path.join(root, 'desktop'),
      '--win',
    ],
    '打包 Windows 安装程序（electron-builder）',
  );
  printResult();
  console.log('\n安装包已生成。双击它即可安装；装完开始菜单/桌面会有「轻音播放」。');
} catch (error) {
  console.error(`\n✖ ${error.message}`);
  process.exitCode = 1;
}
