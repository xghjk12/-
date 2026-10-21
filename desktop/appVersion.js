'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 读应用版本号（托盘 tooltip 与窗口标题都要用它）。
 *
 * 为什么读仓库根的 package.json 而不是直接用 `app.getVersion()`：
 *  - `app.getVersion()` 读的是**入口 package.json**（desktop/package.json），
 *    两个文件各改各的就会分叉；
 *  - 产品的版本号真相在根 package.json（npm test / 发版都看它）。
 * 根 package.json 读不到（打包后仓库结构不在了）就回退 `app.getVersion()`，
 * 由调用方兜底。
 *
 * 纯 Node 模块（不 require electron），单测直接跑：desktop/appVersion.test.cjs。
 */

/**
 * @param {string} repoRoot 仓库根目录（含 package.json）
 * @returns {string | null} 版本号字符串；读不到/不合法返回 null（调用方回退 app.getVersion()）
 */
function readAppVersion(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // 文件不存在（打包后）或 JSON 损坏：交给调用方回退
  }
  return null;
}

module.exports = { readAppVersion };
