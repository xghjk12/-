/**
 * 打包时进 asar 的 desktop/ 文件**白名单**。
 *
 * 为什么用手写白名单而不是黑名单排除：黑名单漏一个测试文件只会让包大一点，
 * **漏掉一个运行期文件却会让装好的软件直接起不来**。所以这里只列运行期真要的，
 * 再加一条测试（desktop/packaging.test.cjs）核对：
 *  - 白名单里的文件都存在；
 *  - main.js / entry.js 里 `require('./x.js')` 到的本地模块都在白名单里；
 *  - 白名单里没有 *.test.cjs / check*.js / verify* 这类非运行期文件。
 * 这样"漏加一个文件"会在 `pnpm verify` 里红，而不是等用户装完打不开才发现。
 */

/** 运行期需要的 desktop/ 文件（相对 desktop/）。顺序无意义。 */
export const desktopRuntimeFiles = Object.freeze([
  'package.json', // Electron 靠它识别 CommonJS + 读取入口
  'entry.js',
  'main.js',
  'constants.js',
  'userData.js',
  'appVersion.js',
  'appProtocol.js',
  'autoStart.js',
  'httpUtils.js',
  'staticServer.js',
  'mainIpc.js',
  'preload.js',
  'playbackStatus.js',
  'shellSettings.js',
  'shellText.js',
  'tray.js',
  'trayMenu.js',
  'window.js',
  'windowState.js',
  'lyricsIpc.js',
  'lyricsTool.js',
  'tools/fill-lyrics.ps1', // 补歌词内置脚本（外部工具没配时的兜底）
  'tools/fake-fill-lyrics.ps1', // 内置脚本自己会调用它做自检/演示
]);

/** 明确**不能**进包的文件后缀/名字（给测试用，也是给接手者的说明）。 */
export const nonRuntimePatterns = Object.freeze([
  /\.test\.cjs$/,
  /^check.*\.js$/,
  /^verify\.(mjs|js)$/,
  /^probe\.js$/, // 开发期 origin 探路脚本，entry.js 用 existsSync 守卫
  /^runProbe\.js$/,
  /^smoke2?\.js$/,
  /^installElectron\.js$/,
  /^start\.ps1$/,
  /^postCloseToQingyin\.ps1$/,
  /^snapshotDesktop\.ps1$/,
  /^driveFolderDialog\.ps1$/,
  /^README\.md$/,
  /^verify\.md$/,
]);
