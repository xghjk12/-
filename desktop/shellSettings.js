'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeWindowState } = require('./windowState.js');

/**
 * 壳层设置持久化：userData/settings.json。
 *
 * 设计取舍：
 *  - schema 只有主进程需要持久化的键。未知键直接丢弃——本版本读不懂的
 *    设置宁可回到默认值，也不把坏结构往后传。以后加键时先在测试里固化
 *    "旧文件（只有旧键）能被读成默认值"这条行为。
 *  - 写入走临时文件 + rename：进程在写一半时被杀，文件要么是完整的旧值
 *    要么是完整的新值，不会留下截断的 JSON。
 *
 * 键：
 *  - openAtLogin      开机自启（t2）
 *  - lyricsToolPath   补歌词工具脚本路径；空串 = 用内置 desktop/tools/fill-lyrics.ps1（t5）
 *  - musicFolderPath  音乐文件夹的绝对路径。**不是装饰**：曲库来自
 *    FileSystemDirectoryHandle，Electron 44 实测拿不到绝对路径
 *    （desktop/checkPathForFile.js 的结论，README §9），所以外部工具要的
 *    路径只能让用户选一次存下来。
 *  - windowState      窗口位置/尺寸/是否最大化（t6）。**刻意不进 IndexedDB**：
 *    窗口几何是"壳"的状态，与曲库数据无关，而且必须在渲染进程起来之前
 *    就能同步读到（开窗那一刻就要用）。结构校验交给 windowState.js 的
 *    sanitizeWindowState——不合法就整个丢成 null（下次用默认几何），
 *    半合法的几何会造出一个更怪的窗口。
 *
 * 纯 Node 模块（不 require electron），单测直接跑：desktop/shellSettings.test.cjs。
 */

const SETTINGS_FILENAME = 'settings.json';
const DEFAULT_SETTINGS = Object.freeze({
  openAtLogin: false,
  lyricsToolPath: '',
  musicFolderPath: '',
  windowState: null,
});

function settingsPath(dir) {
  return path.join(dir, SETTINGS_FILENAME);
}

/** 单键规范化：字符串必须是非空绝对路径（Windows 下至少长得像盘符路径），否则回空串。 */
function normalizeFolderPath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!path.isAbsolute(trimmed)) return '';
  return trimmed;
}

/** lyricsToolPath 的规范化：跟 musicFolderPath 一样要求绝对路径。 */
function normalizeToolPath(value) {
  return normalizeFolderPath(value);
}

/**
 * @param {string} dir userData 目录
 * @returns {{ openAtLogin: boolean, lyricsToolPath: string, musicFolderPath: string, windowState: object | null }}
 */
function loadSettings(dir) {
  try {
    const raw = fs.readFileSync(settingsPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        openAtLogin: parsed.openAtLogin === true,
        lyricsToolPath: normalizeToolPath(parsed.lyricsToolPath),
        musicFolderPath: normalizeFolderPath(parsed.musicFolderPath),
        // 旧存档没有这个键（t6 之前写的文件）→ null = 首次启动，用默认几何
        windowState: sanitizeWindowState(parsed.windowState),
      };
    }
  } catch {
    // 文件不存在（首次启动）或 JSON 损坏：默认值
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * @param {string} dir userData 目录
 * @param {{ openAtLogin?: boolean, lyricsToolPath?: string, musicFolderPath?: string, windowState?: object | null }} settings
 * @returns {{ openAtLogin: boolean, lyricsToolPath: string, musicFolderPath: string, windowState: object | null }} 实际写入的（规范化后）设置
 */
function saveSettings(dir, settings) {
  const current = loadSettings(dir);
  const has = (key) => Boolean(settings && Object.prototype.hasOwnProperty.call(settings, key));
  const next = {
    // 四个键都支持"只传变更项"（部分更新），没传的保持现值。
    // t6 的窗口防抖写盘就靠这条：它只传 { windowState }，不会把自启开关
    // 和补歌词的两个路径一起冲掉。
    openAtLogin: has('openAtLogin') ? settings.openAtLogin === true : current.openAtLogin,
    lyricsToolPath: has('lyricsToolPath') ? normalizeToolPath(settings.lyricsToolPath) : current.lyricsToolPath,
    musicFolderPath: has('musicFolderPath') ? normalizeFolderPath(settings.musicFolderPath) : current.musicFolderPath,
    windowState: has('windowState') ? sanitizeWindowState(settings.windowState) : current.windowState,
  };
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
  normalizeToolPath,
  normalizeFolderPath,
  SETTINGS_FILENAME,
  DEFAULT_SETTINGS,
};
