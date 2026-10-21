'use strict';

const { ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createLyricsToolRunner } = require('./lyricsTool.js');

/**
 * 补歌词的 IPC 层（t5）：
 *  - `lyrics:run`    （invoke，渲染进程/托盘触发）启动工具
 *  - `lyrics:status` （invoke）当前状态快照
 *  - `lyrics:cancel` （invoke）取消——返回的 status 是终态快照
 *    （cancelled 是独立终态，与 lyrics:status / 状态推送完全一致，单一真相）
 *  - `lyrics:status-changed`（事件，主 → 渲染）状态推送，渲染进程据此自动重扫
 *
 * 状态机：idle | running | done | failed | cancelled（取消是主动行为不是故障）。
 *
 * 音乐文件夹路径的解析顺序（checkPathForFile.js 实测：句柄来源的 File 拿不到
 * 绝对路径，webUtils.getPathForFile 返回空串，见 README §9）：
 *   1. settings.musicFolderPath（用户选过一次就存住了）
 *   2. 没存过/已失效 → 弹主进程原生目录对话框让用户选**这一次**（选完即存档）
 *
 * 工具脚本的选择（t9 语义，**绝不静默回退**）：
 *   - settings.lyricsToolPath 为空 → 内置 desktop/tools/fill-lyrics.ps1（正常路径）；
 *   - 非空且文件存在 → 用它（测试指 fake-fill-lyrics.ps1，用户也可以换自己的脚本）；
 *   - 非空但文件不存在 → **快速失败**（failed + 带路径的可读错误，不 spawn 任何
 *     进程）。回退内置是最坏的一种假成功：用户以为自己那个工具跑了，实际
 *     跑的是别的——报错还会张冠李戴（「MUSIC_PATH 无效」跟真正原因无关）。
 */

/**
 * 决定用哪个工具脚本（纯函数，单测在 desktop/lyricsIpc.test.cjs）。
 * @param {{ lyricsToolPath?: string, builtInScriptPath: string }} input
 * @returns {{ scriptPath: string, error?: undefined } | { scriptPath?: undefined, error: string }}
 */
function resolveLyricsToolScript({ lyricsToolPath, builtInScriptPath }) {
  const custom = typeof lyricsToolPath === 'string' ? lyricsToolPath.trim() : '';
  if (!custom) return { scriptPath: builtInScriptPath };
  if (fs.existsSync(custom)) return { scriptPath: custom };
  return {
    error: `补歌词工具路径不存在：${custom}（托盘 → 选择补歌词工具… 可重选，或选「恢复内置脚本」）`,
  };
}

/**
 * 音乐文件夹的预检（纯函数）：**只**拦「存了路径、它也在、但不是目录」这种
 * 配置坏档——错误文案带路径与改法。路径不存在/为空不算错误（走目录对话框，
 * 让用户重选是更好的恢复路径，不是静默回退）。
 * @param {string} musicPath 存档里的音乐文件夹路径
 * @returns {string | null} null = 没问题；字符串 = 带路径的失败原因
 */
function musicFolderProblem(musicPath) {
  if (!musicPath) return null;
  let stats;
  try {
    stats = fs.statSync(musicPath);
  } catch {
    return null; // 不存在 → 由调用方弹目录对话框重选
  }
  if (!stats.isDirectory()) {
    return `音乐文件夹不是目录：${musicPath}（托盘 → 指定音乐文件夹… 可重选）`;
  }
  return null;
}

function installLyricsIpc(context) {
  const {
    repoRoot,
    builtInScriptPath,
    getSettings,
    saveSettingsPatch,
    broadcast, // (channel, payload) => void，推给所有窗口
    onStateChanged, // 状态变化回调（main.js 用它刷托盘菜单）
    pickMusicFolder, // (reason) => Promise<string | null>：无存档路径时的目录选择
    pickToolScript, // (current) => Promise<{ path: string | null, reset: boolean }>
    maxDurationMs,
  } = context;

  ipcMain.removeHandler('lyrics:run');
  ipcMain.removeHandler('lyrics:status');
  ipcMain.removeHandler('lyrics:cancel');

  const runner = createLyricsToolRunner({
    defaultScriptPath: builtInScriptPath,
    maxDurationMs,
    onStateChange: (state) => {
      broadcast('lyrics:status-changed', state);
      onStateChanged?.(state);
    },
  });

  function currentScriptPath() {
    const custom = getSettings().lyricsToolPath;
    // scriptInUse 的语义：配置的自定义脚本**原样**报出（哪怕它已经失效）——
    // 绝不能在坏路径上报内置（那等于告诉用户"现在用的是内置"，撒谎）。
    const trimmed = typeof custom === 'string' ? custom.trim() : '';
    return trimmed || builtInScriptPath;
  }

  /**
   * 启动一次补歌词（托盘菜单项与渲染进程按钮走同一个函数）。
   * 预检失败 → 状态机直接落 failed（带路径的可读错误），**不 spawn 任何进程**。
   * @returns {Promise<{ ok: boolean, reason?: string, status: object, musicPath?: string }>}
   */
  async function startFill() {
    if (runner.status().status === 'running') {
      return { ok: false, reason: 'already-running', status: runner.status() };
    }
    let musicPath = getSettings().musicFolderPath;
    if (!musicPath || !fs.existsSync(musicPath)) {
      const picked = await pickMusicFolder('曲库句柄拿不到绝对路径，请为补歌词工具指定音乐文件夹（只问这一次）');
      if (!picked) {
        return { ok: false, reason: 'no-music-path', status: runner.status() };
      }
      musicPath = picked;
      saveSettingsPatch({ musicFolderPath: picked });
    }

    // 工具脚本预检（t9）：自定义路径失效 → 快速失败，绝不静默回退到内置
    const resolved = resolveLyricsToolScript({
      lyricsToolPath: getSettings().lyricsToolPath,
      builtInScriptPath,
    });
    if (resolved.error) {
      const custom = getSettings().lyricsToolPath;
      runner.failFast(resolved.error, path.basename(String(custom).trim() || 'unknown'));
      return { ok: false, reason: 'tool-script-missing', status: runner.status() };
    }

    // 音乐文件夹预检（t9 顺手）：存了路径但它是个文件 → 快速失败带路径
    const folderProblem = musicFolderProblem(musicPath);
    if (folderProblem) {
      runner.failFast(folderProblem);
      return { ok: false, reason: 'music-folder-invalid', status: runner.status() };
    }

    const scriptPath = resolved.scriptPath;
    const result = runner.run({ scriptPath, musicPath });
    if (!result.started) {
      return { ok: false, reason: result.reason, status: result.status };
    }
    return { ok: true, status: result.status, musicPath, scriptPath };
  }

  ipcMain.handle('lyrics:run', () => startFill());
  ipcMain.handle('lyrics:status', () => runner.status());
  ipcMain.handle('lyrics:cancel', () => runner.cancel());

  /** 托盘「指定音乐文件夹…」：手动改存档路径（也是退路的显式入口）。 */
  async function chooseMusicFolder() {
    const picked = await pickMusicFolder('选择补歌词工具要扫描的音乐文件夹');
    if (!picked) return { changed: false };
    saveSettingsPatch({ musicFolderPath: picked });
    return { changed: true, musicFolderPath: picked };
  }

  /** 托盘「选择补歌词工具…」：换脚本；取消时若当前是自定义脚本，询问是否恢复内置。 */
  async function chooseToolScript() {
    const current = getSettings().lyricsToolPath;
    const result = await pickToolScript(current);
    if (result.path) {
      saveSettingsPatch({ lyricsToolPath: result.path });
      return { changed: true, lyricsToolPath: result.path };
    }
    if (result.reset && current) {
      saveSettingsPatch({ lyricsToolPath: '' });
      return { changed: true, lyricsToolPath: '' };
    }
    return { changed: false };
  }

  return {
    startFill,
    chooseMusicFolder,
    chooseToolScript,
    status: () => runner.status(),
    scriptInUse: currentScriptPath,
  };
}

module.exports = { installLyricsIpc, resolveLyricsToolScript, musicFolderProblem };
