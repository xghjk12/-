'use strict';

const { ipcMain } = require('electron');
const fs = require('node:fs');
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
 *   2. 没存过 → 弹主进程原生目录对话框让用户选**这一次**（选完即存档，之后不再问）
 *
 * 工具脚本的选择：settings.lyricsToolPath 非空 → 用它（测试指 fake-fill-lyrics.ps1，
 * 用户也可以换自己的脚本）；空 → 内置 desktop/tools/fill-lyrics.ps1。
 */

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
    return custom && fs.existsSync(custom) ? custom : builtInScriptPath;
  }

  /**
   * 启动一次补歌词（托盘菜单项与渲染进程按钮走同一个函数）。
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

    const scriptPath = currentScriptPath();
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

module.exports = { installLyricsIpc };
