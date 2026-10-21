'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 壳层设置（开机自启开关）持久化：userData/settings.json。
 *
 * 设计取舍：
 *  - schema 刻意只有 openAtLogin 一个键。未知键直接丢弃——本版本读不懂的
 *    设置宁可回到默认值，也不把坏结构往后传。以后加键时先在测试里固化
 *    "旧文件（只有旧键）能被读成默认值"这条行为。
 *  - 写入走临时文件 + rename：进程在写一半时被杀，文件要么是完整的旧值
 *    要么是完整的新值，不会留下截断的 JSON。
 *
 * 纯 Node 模块（不 require electron），单测直接跑：desktop/shellSettings.test.cjs。
 */

const SETTINGS_FILENAME = 'settings.json';
const DEFAULT_SETTINGS = Object.freeze({ openAtLogin: false });

function settingsPath(dir) {
  return path.join(dir, SETTINGS_FILENAME);
}

/**
 * @param {string} dir userData 目录
 * @returns {{ openAtLogin: boolean }}
 */
function loadSettings(dir) {
  try {
    const raw = fs.readFileSync(settingsPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { openAtLogin: parsed.openAtLogin === true };
    }
  } catch {
    // 文件不存在（首次启动）或 JSON 损坏：默认值
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * @param {string} dir userData 目录
 * @param {{ openAtLogin: boolean }} settings
 * @returns {{ openAtLogin: boolean }} 实际写入的（规范化后的）设置
 */
function saveSettings(dir, settings) {
  const next = { openAtLogin: settings?.openAtLogin === true };
  const file = settingsPath(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

module.exports = {
  loadSettings,
  saveSettings,
  settingsPath,
  SETTINGS_FILENAME,
  DEFAULT_SETTINGS,
};
