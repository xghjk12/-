'use strict';

const { Menu, Tray, nativeImage } = require('electron');

const { buildTrayMenuTemplate } = require('./trayMenu.js');
const { trayTooltip } = require('./shellText.js');

/**
 * 应用托盘。与 trayMenu.js（纯模板）分工：这里负责接 electron——
 * Tray 对象、图标、菜单接线、左键点击、以及给验证脚本用的只读快照。
 *
 * @param {object} options
 * @param {string} options.iconPath 图标 PNG 绝对路径（192px 原图即可，内部缩放）
 * @param {string} options.appName 应用名（tooltip 用）
 * @param {string} options.version 版本号（tooltip 用）
 * @param {() => boolean} options.isVisible 主窗口当前是否可见（菜单文案换向用）
 * @param {() => boolean} options.getOpenAtLogin 自启开关当前值（checkbox 勾选用）
 * @param {() => string | null} options.getUpdateAvailable 挂起的新版本号（本期恒 null）
 * @param {() => { status: string, exitCode: number | null }} options.getLyricsToolState 补歌词工具状态（t5 菜单文案）
 * @param {() => void} options.onToggleWindow 左键/菜单：切换窗口显隐
 * @param {() => void} options.onShowWindow 双击兜底：确保窗口可见（双击会先触发两次 click）
 * @param {(checked: boolean) => void} options.onSetOpenAtLogin 菜单：自启开关
 * @param {() => void} options.onQuit 菜单：退出
 * @param {() => void} options.onFillLyrics 菜单：补歌词（t5）
 * @param {() => void} options.onChooseMusicFolder 菜单：指定音乐文件夹（t5）
 * @param {() => void} options.onChooseToolScript 菜单：选择补歌词工具（t5）
 * @returns {{ tray: Electron.Tray, refresh: () => void, describe: () => Array<object>, destroy: () => void }}
 */
function createAppTray(options) {
  // Windows 通知区图标按系统 DPI 请求 16/24/32px；直接塞 192px 原图
  // 会被粗暴缩小发糊，主动 resize 到 32 最稳。
  const image = nativeImage.createFromPath(options.iconPath);
  if (image.isEmpty()) {
    throw new Error(`托盘图标读取失败：${options.iconPath}`);
  }
  const tray = new Tray(image.resize({ width: 32, height: 32 }));

  let lastTemplate = [];

  /** 状态变化后重建菜单与 tooltip（显隐/自启/更新提示/工具状态任一变化都要调）。 */
  function refresh() {
    const lyricsState = options.getLyricsToolState ? options.getLyricsToolState() : { status: 'idle' };
    const state = {
      windowVisible: Boolean(options.isVisible()),
      openAtLogin: Boolean(options.getOpenAtLogin()),
      updateAvailable: options.getUpdateAvailable() ?? null,
      version: options.version,
      lyricsToolStatus: lyricsState?.status,
      lyricsToolExitCode: lyricsState?.exitCode ?? null,
    };
    const template = buildTrayMenuTemplate(state);
    const click = {
      'toggle-window': () => options.onToggleWindow(),
      'fill-lyrics': () => options.onFillLyrics?.(),
      'lyrics-music-folder': () => options.onChooseMusicFolder?.(),
      'lyrics-tool-settings': () => options.onChooseToolScript?.(),
      'open-at-login': (item) => options.onSetOpenAtLogin(item.checked),
      // 预留位：本期菜单项恒禁用，到不了这里；接线先留好
      'check-update': () => {},
      quit: () => options.onQuit(),
    };
    for (const item of template) {
      if (item.id && click[item.id]) {
        item.click = click[item.id];
      }
    }
    lastTemplate = template;
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(
      trayTooltip({
        appName: options.appName,
        version: state.version,
        updateAvailable: state.updateAvailable,
      })
    );
  }

  // Windows：左键点图标 = 切换窗口（右键出菜单是 electron 默认）。
  // macOS：左键点图标默认就出菜单，不注册 click，避免"又弹菜单又切窗口"。
  if (process.platform !== 'darwin') {
    tray.on('click', () => options.onToggleWindow());
    // 双击会先触发两次 click（净效果回到原状态），再触发本事件——
    // 所以这里必须"确保可见"，不能再 toggle（否则双击的结果是窗口被藏起来）
    if (options.onShowWindow) {
      tray.on('double-click', () => options.onShowWindow());
    }
  }

  refresh();

  return {
    tray,
    refresh,
    /** 给验证脚本（checkTray.js 的 app.evaluate）用的 JSON 安全快照。 */
    describe: () =>
      lastTemplate.map((item) => ({
        id: item.id,
        label: item.label,
        type: item.type,
        enabled: item.enabled !== false,
        checked: item.checked === true,
      })),
    destroy: () => {
      // 通知区图标不主动清会一直挂到托盘进程重启（Windows 的老毛病）
      tray.destroy();
    },
  };
}

module.exports = { createAppTray };
