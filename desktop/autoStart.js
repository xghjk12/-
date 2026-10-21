'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Windows 开机自启：直接管理 HKCU Run 注册表项。
 *
 * 为什么不用 `app.setLoginItemSettings`（Electron 官方 API）：
 * 在本机 Electron 44.9.1 上实测它**静默失效**——三种调用方式
 * （全默认 / 显式 path+args / 显式 name，外加先 setAppUserModelId）全都
 * 既不写 `HKCU\…\CurrentVersion\Run`，也不写 `…\Explorer\StartupApproved\Run`，
 * `getLoginItemSettings` 读回永远是 false，`launchItems` 恒为空数组
 * （实验记录见 desktop/README.md §8）。二进制里确认了实现存在
 * （StartupApproved/Run、`electron.app.$1` 字符串都在），但就是不落盘。
 * 与其赌上游修好，不如自己写 Run 项——行为完全可控、可验证、
 * 开发态和打包后都一样。
 *
 * 写入策略（对齐 Electron 老版本的写法）：
 *  - Run 键：`qingyin-player` = `"…exe" [args…]`（REG_SZ）
 *  - StartupApproved\Run：同名 REG_BINARY = 02 00 …（"已启用"，任务管理器里
 *    显示为启用；不写这项 Windows 默认也会启动，但写了状态才一致）
 *  - 读回用 `reg export`（UTF-16LE 文件）解析——`reg query` 的控制台输出
 *    走 OEM 代码页，中文路径会变乱码，不能用来做精确比对。
 *
 * 纯逻辑（命令拼装、.reg 文本解析）拆成了纯函数，单测在
 * desktop/autoStart.test.cjs。
 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
/** StartupApproved 的「已启用」值：DWORD 02 + 12 字节零（03+FILETIME 是禁用）。 */
const APPROVED_ENABLED_HEX = '02000000000000000000000000000000';

/**
 * 拼注册表 Run 值的命令字符串。
 * exe 恒定加引号；参数含空格或非 ASCII（中文路径）时也加引号。
 * @param {string} exePath
 * @param {string[]} args
 * @returns {string}
 */
function buildRunCommand(exePath, args) {
  const parts = [`"${exePath}"`];
  for (const arg of args ?? []) {
    const needsQuotes = /[\s"]/.test(arg) || /[^\x20-\x7e]/.test(arg);
    parts.push(needsQuotes ? `"${arg}"` : arg);
  }
  return parts.join(' ');
}

/**
 * 解析 `reg export` 输出的 .reg 文本（UTF-16LE 读入后的字符串），
 * 提取指定值名的 REG_SZ 数据。.reg 格式：`"名字"="数据"`，
 * 内嵌引号转义为 `\"`、反斜杠转义为 `\\`。
 * @param {string} regFileText
 * @param {string} name
 * @returns {string | null}
 */
function parseRegExportValue(regFileText, name) {
  if (!regFileText) return null;
  const needle = `"${name}"=`;
  for (const rawLine of regFileText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(needle)) continue;
    let data = line.slice(needle.length);
    if (data.startsWith('"')) {
      data = data.slice(1);
      const end = data.lastIndexOf('"');
      if (end === -1) return null;
      data = data.slice(0, end);
    } else if (data.startsWith('hex:')) {
      // REG_BINARY 等十六进制形态：本模块只读 REG_SZ，防误用直接判空
      return null;
    } else {
      return null;
    }
    // .reg 转义还原：\\ → \，\" → "（顺序：先还原反斜杠对，再还原引号）
    return data.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  }
  return null;
}

/**
 * 跑一次 reg.exe，收齐输出与退出码。
 * 注意：Electron 主进程里 spawn 的行为与纯 Node 不完全一致（本机实测
 * stdio:'ignore' 会让 Electron 直接崩——见 README §8），所以这里用管道
 * stdio 并把 error 事件原样抛给调用方。
 */
function regRun(args) {
  return new Promise((resolve) => {
    const child = spawn('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr, error: null }));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr, error: String(error) }));
  });
}

/**
 * 读当前 Run 项的命令字符串（用 reg export 避免 OEM 代码页乱码）。
 * @param {{ name: string }} options
 * @returns {Promise<string | null>} 值不存在返回 null
 */
async function readLoginItemCommand({ name }) {
  const tmpFile = path.join(
    fs.realpathSync(os.tmpdir()),
    `qingyin-reg-${process.pid}-${Date.now()}.reg`,
  );
  const exportRes = await regRun(['export', RUN_KEY, tmpFile, '/y']);
  if (exportRes.code !== 0) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 临时文件可能没建出来
    }
    // Run 键本身不存在（异常环境）或 reg 失败：抛出来，调用方必须能看见
    throw new Error(
      `reg export 失败（exit=${exportRes.code}${exportRes.error ? `，${exportRes.error}` : ''}）：${(exportRes.stderr || '').trim()}`,
    );
  }
  try {
    // reg export 写的是 UTF-16LE（带 BOM）
    const text = fs.readFileSync(tmpFile, 'utf16le').replace(/^\ufeff/, '');
    return parseRegExportValue(text, name);
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 清理失败就算了，tmp 里的临时文件
    }
  }
}

/**
 * 只读「值是否存在」（reg query，纯 stdout，不写任何文件）。
 *
 * 用途：在 reg export 的临时文件写入被环境限制时（见 README §8——DSH 沙箱
 * 下 Electron 的子进程被降权），作为 app 侧读回的兜底。注意 reg query 的
 * stdout 走 OEM 代码页，含中文的命令会是乱码，所以这里只判断存在性
 * （退出码 0 + REG_SZ 行），不做命令比对；精确比对留给 export 路径。
 * @param {{ name: string }} options
 * @returns {Promise<boolean>}
 */
async function readLoginItemPresent({ name }) {
  const queryRes = await regRun(['query', RUN_KEY, '/v', name]);
  if (queryRes.error || queryRes.code !== 0) return false;
  return queryRes.stdout.includes('REG_SZ');
}

/**
 * 启用开机自启（写 Run + StartupApproved）。
 * @param {{ exePath: string, args: string[], name: string }} options
 * @returns {Promise<{ ok: boolean, command: string }>}
 */
async function enableLoginItem({ exePath, args, name }) {
  const command = buildRunCommand(exePath, args);
  const runRes = await regRun(['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', command, '/f']);
  if (runRes.error || runRes.code !== 0) {
    throw new Error(
      `reg add Run 失败（exit=${runRes.code}${runRes.error ? `，${runRes.error}` : ''}）：${(runRes.stderr || '').trim()}`,
    );
  }
  const approvedRes = await regRun([
    'add',
    APPROVED_KEY,
    '/v',
    name,
    '/t',
    'REG_BINARY',
    '/d',
    APPROVED_ENABLED_HEX,
    '/f',
  ]);
  return { ok: runRes.code === 0, command, approved: approvedRes.code === 0 };
}

/**
 * 关掉开机自启（删 Run + StartupApproved 的同名值；值不存在也算成功）。
 * @param {{ name: string }} options
 * @returns {Promise<{ ok: boolean }>}
 */
async function disableLoginItem({ name }) {
  const runRes = await regRun(['delete', RUN_KEY, '/v', name, '/f']);
  const approvedRes = await regRun(['delete', APPROVED_KEY, '/v', name, '/f']);
  // reg delete 对不存在的值返回 1；禁用成功的目标态就是"没有"，所以不算失败
  return { ok: true, runExit: runRes.code, approvedExit: approvedRes.code };
}

module.exports = {
  buildRunCommand,
  parseRegExportValue,
  readLoginItemCommand,
  readLoginItemPresent,
  enableLoginItem,
  disableLoginItem,
  RUN_KEY,
  APPROVED_KEY,
  APPROVED_ENABLED_HEX,
};
