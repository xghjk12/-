'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { APP_ID } = require('./constants.js');

/**
 * 选定并钉死 userData 目录（IndexedDB / localStorage / 缓存都在里面）。
 *
 * == 为什么不能直接用 Electron 的默认值 ==
 * 默认是 `%APPDATA%/<app name>`。本机实测：electron.exe 在**整个用户目录下建目录一律 EPERM**
 * （Roaming / Local / Temp / 用户主目录全都写不进去，而 PowerShell 用同一个账号可以写；
 * 大概率是安全软件的"反勒索/受控文件夹"策略拦了未签名的 electron.exe）。
 * 后果不是"报个错"这么温和，而是一连串看起来毫不相干的崩溃：
 *  - `app.getPath('userData')` 直接硬崩（进程没了，不是 JS 异常）
 *  - `app.getLocale()` 返回空串
 *  - Chromium 走到 ready 时 EXCEPTION_ACCESS_VIOLATION (0xC0000005)
 *  - 就算 `--no-sandbox` 绕过前面几步活到页面渲染，IndexedDB 也全是
 *    `UnknownError: Internal error.`，磁盘缓存报 `Unable to create cache`
 *    —— 也就是说**用户数据一条都存不下来**，而这正是桌面端最要命的东西。
 *
 * 所以这里做三件事：
 *  1. 允许用 `--user-data-dir=` / `QINGYIN_USER_DATA` 显式指定（自动化与排障都靠它）
 *  2. 默认仍然用 `%APPDATA%/<APP_ID>`（正常机器上就该放这儿，跟着系统走）
 *  3. **建目录失败就换到仓库里的 `artifacts/desktop/userdata`**（已被 .gitignore 忽略），
 *     并把这件事大声说出来——静默降级会让"数据怎么没了"变成悬案
 *
 * == 另一条必须钉死的规矩 ==
 * `app.setPath('userData', ...)` 必须在 **ready 之前**调用，而且任何时候都不要
 * 在 setPath 之前调 `app.getPath('userData')`（本机那条路径会直接把进程崩掉）。
 */

const SWITCH_PREFIX = '--user-data-dir=';

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function fromSwitch() {
  const hit = process.argv.find((item) => item.startsWith(SWITCH_PREFIX));
  return hit ? path.resolve(hit.slice(SWITCH_PREFIX.length)) : undefined;
}

/** 能不能在这个目录里建目录 + 写文件。只试不留下垃圾。 */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probeFile = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    fs.rmSync(probeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 选目录。
 *
 * @returns {{ dir: string, requested: string, fellBack: boolean, reason?: string }}
 */
function resolveUserDataDir() {
  const requested =
    fromSwitch() ||
    (process.env.QINGYIN_USER_DATA ? path.resolve(process.env.QINGYIN_USER_DATA) : undefined) ||
    path.join(app.getPath('appData'), APP_ID);

  if (isWritable(requested)) {
    return { dir: requested, requested, fellBack: false };
  }

  const fallback = path.join(repoRoot(), 'artifacts', 'desktop', 'userdata');
  const reason = `无法在 ${requested} 下创建目录（多半是安全软件拦了 electron.exe 写用户目录）`;
  if (isWritable(fallback)) {
    return { dir: fallback, requested, fellBack: true, reason };
  }
  // 两处都写不了：还是返回默认值，让后面的错误信息指向真正的位置
  return { dir: requested, requested, fellBack: false, reason: `${reason}；备用目录 ${fallback} 也写不了` };
}

/**
 * 在 ready 之前调用：把 userData 钉死，并返回选择结果（调用方要把它写进日志/报告）。
 */
function pinUserData() {
  const resolved = resolveUserDataDir();
  app.setName(APP_ID);
  app.setPath('userData', resolved.dir);
  return resolved;
}

module.exports = { pinUserData, resolveUserDataDir, isWritable };
