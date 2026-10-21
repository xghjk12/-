'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * 补下 Electron 的二进制。
 *
 * 为什么需要这个脚本：`pnpm add -D electron` 在这台机器上只会装 npm 包，
 * **不会执行 electron 的 postinstall**（pnpm 12 不再读 package.json 里的
 * `pnpm.onlyBuiltDependencies`，那个设置搬去了 pnpm-workspace.yaml；
 * 本仓库没有这个文件，所以构建脚本默认被跳过）。
 * 结果就是 `node_modules/electron/dist/electron.exe` 不存在，一启动就报
 * "Electron failed to install correctly"。
 *
 * 这个脚本只调 electron 官方自带的 install.js，并且默认走 npmmirror 镜像——
 * 本机的 hosts 把 github.com / objects.githubusercontent.com 指到了 127.0.0.1
 * （Steam++ 加速器），直连 GitHub Releases 下不动，所以镜像不是可选项而是必需项。
 *
 *   node desktop/installElectron.js
 */

const repoRoot = path.resolve(__dirname, '..');
const MIRROR = 'https://npmmirror.com/mirrors/electron/';

function electronBinary() {
  const pkgDir = path.join(repoRoot, 'node_modules', 'electron');
  const pathFile = path.join(pkgDir, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;
  const relative = fs.readFileSync(pathFile, 'utf8').trim();
  const absolute = path.join(pkgDir, relative);
  return fs.existsSync(absolute) ? absolute : null;
}

const existing = electronBinary();
if (existing) {
  console.log(`Electron 已就位：${path.relative(repoRoot, existing)}`);
  process.exit(0);
}

const installScript = path.join(repoRoot, 'node_modules', 'electron', 'install.js');
if (!fs.existsSync(installScript)) {
  console.error('找不到 node_modules/electron/install.js：先跑 pnpm add -D electron');
  process.exit(1);
}

const mirror = process.env.ELECTRON_MIRROR || MIRROR;
console.log(`ELECTRON_MIRROR = ${mirror}`);
console.log('开始下载 Electron 二进制（约 150MB）…');

const result = spawnSync(process.execPath, [installScript], {
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_MIRROR: mirror },
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error(`\n下载失败（退出码 ${result.status}）。上面是 @electron/get 的原始报错，别改 hosts，先看清错误再说。`);
  process.exit(result.status ?? 1);
}

const installed = electronBinary();
console.log(installed ? `完成：${path.relative(repoRoot, installed)}` : '完成，但没找到二进制，请检查 node_modules/electron/path.txt');
process.exit(installed ? 0 : 1);
