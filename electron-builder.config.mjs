/**
 * 打包配置（`pnpm dist`）。
 *
 * 目标：产出一个用户可**双击安装**的 Windows 软件，而不是"一套源代码 + 一条命令行"。
 * 安装后有开始菜单项 / 桌面快捷方式 / 卸载入口；双击图标就打开播放器。
 *
 * == 目录布局为什么是这样 ==
 * 主进程用 `path.resolve(__dirname, '..')` 当"应用根"，然后找 `<根>/dist`（前端产物）
 * 和 `<根>/desktop/tools/fill-lyrics.ps1`（补歌词内置脚本）。
 * 所以打包后必须满足：<app>/desktop/main.js 与 <app>/dist/index.html 是兄弟关系。
 *   - desktop/**    → 进 asar（代码，只读）
 *   - dist/**       → extraResources 落到 <app>/dist（前端静态文件，走文件系统比走 asar 稳）
 * 两者路径推导完全一致，开发形态和打包形态共用同一句 `resolve(__dirname, '..')`。
 *
 * == 刻意不打进包里的东西 ==
 * 测试脚本（*.test.cjs）、验收脚本（check*.js / verify.mjs）、探针（probe.js / smoke*.js）、
 * playwright-core（只有验收脚本用）。它们体积不小，而且带着 CDP 调试入口，产品里不需要。
 * 见 build/desktopRuntimeFiles.js 的白名单。
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { desktopRuntimeFiles } from './build/desktopRuntimeFiles.js';

/**
 * 配置文件自己在仓库根目录，所以 root 就是它所在的目录——
 * 不要写 `'..'`（那会解析到盘符根 `D:\`，产物掉到 `D:\artifacts`，
 * extraResources 也会指向不存在的 `D:\dist`，build 会以一个
 * "Application entry file index.js is corrupted" 的误导性错误失败）。
 */
const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Electron 版本必须**精确**。
 *
 * 根 package.json 写的是 `^44.9.1`（范围），而 electron-builder 要按确切版本下载
 * 对应平台的二进制，范围它解析不了，会直接拒绝打包。所以这里从实际安装的
 * node_modules 里读真实版本，钉进配置——比手写一个常量更不容易和依赖脱节。
 */
const require = createRequire(import.meta.url);
function resolveElectronVersion() {
  try {
    return require('electron/package.json').version;
  } catch {
    throw new Error('读不到已安装的 electron 版本，先 pnpm install');
  }
}

export default {
  appId: 'cn.qingyin.player',
  productName: '轻音播放',
  copyright: '轻音播放 · 本地音乐播放器',
  /** 精确版本（根 package.json 是范围写法，builder 不接受——见上面的说明）。 */
  electronVersion: resolveElectronVersion(),

  /** 直接输出可安装的 exe（NSIS），不做便携版：用户要的是"装好的软件"。 */
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: path.join(root, 'public', 'icons', 'icon.ico'),
    // 未做代码签名：安装时 SmartScreen 会提示"未知发布者"，这是事实，不掩饰
    signAndEditExecutable: true,
    artifactName: '轻音播放-${version}-安装包.${ext}',
  },

  nsis: {
    oneClick: false, // 给用户选安装目录的机会（一键安装会硬塞进 AppData）
    perMachine: false, // 装到当前用户，不需要管理员权限，卸载也干净
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '轻音播放',
    uninstallDisplayName: '轻音播放',
    // 卸载时**保留**用户数据：曲库元数据与歌词在 %APPDATA%\qingyin-player
    deleteAppDataOnUninstall: false,
    installerIcon: path.join(root, 'public', 'icons', 'icon.ico'),
    uninstallerIcon: path.join(root, 'public', 'icons', 'icon.ico'),
    installerHeaderIcon: path.join(root, 'public', 'icons', 'icon.ico'),
  },

  /**
   * 应用本体：只放运行期真正需要的文件（白名单在 build/desktopRuntimeFiles.js）。
   *
   * 应用根由 CLI 的 `--projectDir desktop` 指定（见 scripts/build-app.mjs）——
   * 不能用 `--projectDir` 之外的方式：desktop/ 里有 package.json（`main: entry.js`），
   * 而仓库根的 package.json 是 `type: module` 且没有 main，builder 会去找 index.js
   * 然后报 "Application entry file index.js is corrupted"（本轮实测踩过）。
   * 注意配置里**没有** appDirectory 这个字段，写了会被 schema 校验拒掉。
   */
  files: [
    ...desktopRuntimeFiles.map((file) => file),
    '!**/*.map',
  ],

  /**
   * 前端产物 + 外部工具脚本放到 <app>/dist 与 <app>/tools（asar 外面）。
   *
   * 为什么不塞进 asar：
   *  - dist：静态服务用 node:fs 读文件，放外面还能"装完直接看到 index.html"，便于验证。
   *  - desktop/tools/*.ps1：**必须**在外面。powershell.exe 是独立进程，它看不见
   *    asar 这个虚拟容器，传进去的 -File 路径在它眼里根本不存在，补歌词会直接失败。
   */
  extraResources: [
    { from: path.join(root, 'dist'), to: 'dist' },
    { from: path.join(root, 'desktop', 'tools'), to: 'tools' },
  ],

  directories: {
    output: path.join(root, 'artifacts', 'dist-app'),
    buildResources: path.join(root, 'public', 'icons'),
  },

  /** 压缩级别：maximum 让安装包小一些，代价是打包慢几十秒（值得）。 */
  compression: 'maximum',

  /** 不打 sourcemap、不生成 blockmap（不做增量更新）。 */
  generateUpdatesFilesForAllChannels: false,
  publish: null,

  asar: true,
  /**
   * asar 里允许解包的只有原生模块。本项目没有原生模块（music-metadata 是纯 JS，
   * 跑在渲染进程里），所以这里保持空——列出来只是提醒接手者：真加了原生依赖才需要改。
   */
  asarUnpack: [],
};
