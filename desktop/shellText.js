'use strict';

/**
 * 壳层文案：托盘 tooltip 与窗口标题的版本号拼装。
 *
 * 为什么窗口标题要带版本号：任务的验收点之一是"版本号可见"。应用本身在
 * 播放时会改 document.title（「歌名 - 轻音播放」，src/ui/store.ts），所以
 * 不能只在创建窗口时设置一次——主进程在 page-title-updated 里拦截并补版本
 * （main.js）。这个模块就是那条链上的纯拼装函数。
 *
 * 纯 Node 模块（不 require electron），单测直接跑：desktop/shellText.test.cjs。
 */

/**
 * 托盘 tooltip。挂起更新时多一行提示（本期没有更新源，恒为无）。
 * @param {{ appName: string, version: string, updateAvailable: string | null }} parts
 * @returns {string}
 */
function trayTooltip({ appName, version, updateAvailable }) {
  let tip = `${appName} v${version}`;
  if (updateAvailable) {
    tip += `\n有新版本 v${updateAvailable} 可用`;
  }
  return tip;
}

/**
 * 页面标题末尾补版本号。
 * @param {string} pageTitle 页面当前标题（「轻音播放」或「歌名 - 轻音播放」）；空/缺省时用 fallbackTitle
 * @param {string} version
 * @param {string} fallbackTitle 页面标题为空时的兜底（一般传应用名）
 * @returns {string}
 */
function titleWithVersion(pageTitle, version, fallbackTitle) {
  const base =
    typeof pageTitle === 'string' && pageTitle.trim() ? pageTitle.trim() : fallbackTitle;
  const suffix = ` v${version}`;
  // page-title-updated 每次改标题都会触发；已经补过的不要重复补
  if (base.includes(suffix)) {
    return base;
  }
  return base + suffix;
}

module.exports = { trayTooltip, titleWithVersion };
