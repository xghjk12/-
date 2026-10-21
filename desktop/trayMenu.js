'use strict';

const { playPauseLabel } = require('./playbackStatus.js');

/**
 * 托盘菜单模板（纯数据，不 require electron）。
 *
 * 职责拆分：这里只产出「长什么样的菜单」，点击行为由 desktop/tray.js 在
 * buildFromTemplate 之前按 id 注入。这样模板结构可以离开 electron 直接单测
 * （desktop/trayMenu.test.cjs），真托盘的接线问题与文案问题分开修。
 *
 * 菜单结构（Windows 通知区右键）：
 *   显示/隐藏窗口（随可见状态换文案）
 *   ---
 *   播放/暂停（随播放状态换文案）/ 上一首 / 下一首    t6
 *   ---
 *   补歌词…（随工具状态换文案：进行中/上次结果）     t5
 *   指定音乐文件夹…（补歌词工具要的路径）            t5
 *   选择补歌词工具…（默认内置脚本，可换自己的）      t5
 *   ---
 *   开机自启（checkbox）
 *   ---
 *   当前版本 / 新版本提示（本期禁用 = 预留位）
 *   ---
 *   退出
 *
 * @param {{
 *   windowVisible: boolean,
 *   openAtLogin: boolean,
 *   version: string,
 *   updateAvailable: string | null,
 *   playback?: { playing: boolean, hasTrack: boolean } | null,
 *   lyricsToolStatus?: string,
 *   lyricsToolExitCode?: number | null,
 * }} state
 * @returns {Array<object>} electron Menu 模板（不含 click，id 由 tray.js 消费）
 */
function buildTrayMenuTemplate({ windowVisible, openAtLogin, version, updateAvailable, playback, lyricsToolStatus, lyricsToolExitCode }) {
  const items = [];

  items.push({
    id: 'toggle-window',
    label: windowVisible ? '隐藏窗口' : '显示窗口',
  });

  items.push({ type: 'separator' });

  // 播放控制（t6）。窗口隐藏时这三项照样有效——渲染进程没销毁，命令走
  // webContents.send，这正是"关窗到托盘继续放歌"的配套能力。
  // 没有"当前曲目"时一律禁用：点下去没反应比灰着更让人困惑。
  // 状态来自渲染进程上报（playbackStatus.js 规范化），主进程不猜。
  const canControl = Boolean(playback?.hasTrack);
  items.push({
    id: 'play-pause',
    label: playPauseLabel(playback),
    enabled: canControl,
  });
  items.push({
    id: 'prev',
    label: '上一首',
    enabled: canControl,
  });
  items.push({
    id: 'next',
    label: '下一首',
    enabled: canControl,
  });

  items.push({ type: 'separator' });

  // 补歌词：t5。状态化文案——running 时再点会直接拒绝（主进程有 already-running 守卫），
  // done/failed/cancelled 提示上一轮结果，帮用户判断"刚才那次怎么样了"。
  // cancelled 是独立终态（用户主动取消，t8）：文案不带「失败」字眼。
  let fillLabel = '补歌词…';
  if (lyricsToolStatus === 'running') fillLabel = '补歌词…（运行中）';
  else if (lyricsToolStatus === 'done') fillLabel = '补歌词…（上次成功）';
  else if (lyricsToolStatus === 'cancelled') fillLabel = '补歌词…（上次已取消）';
  else if (lyricsToolStatus === 'failed') {
    fillLabel = '补歌词…（上次失败）';
  }
  items.push({
    id: 'fill-lyrics',
    label: fillLabel,
    enabled: lyricsToolStatus !== 'running',
  });

  items.push({ id: 'lyrics-music-folder', label: '指定音乐文件夹…' });
  items.push({ id: 'lyrics-tool-settings', label: '选择补歌词工具…' });

  items.push({ type: 'separator' });

  items.push({
    id: 'open-at-login',
    label: '开机自启',
    type: 'checkbox',
    checked: openAtLogin === true,
  });

  items.push({ type: 'separator' });

  // 更新提示位：本期明确不做自动更新（任务边界），菜单项始终禁用。
  // 有更新源之后：updateAvailable 有值 → 换文案并启用，让 t2 之外的未来功能
  // 只改这一个分支。
  items.push({
    id: 'check-update',
    label: updateAvailable
      ? `有新版本 v${updateAvailable} 可用`
      : `当前 v${version} · 检查更新下一期提供`,
    enabled: Boolean(updateAvailable),
  });

  items.push({ type: 'separator' });

  items.push({
    id: 'quit',
    label: '退出',
  });

  return items;
}

module.exports = { buildTrayMenuTemplate };
