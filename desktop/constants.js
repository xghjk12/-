'use strict';

/**
 * 桌面端的三个"一旦定了就不能改"的常量。
 *
 * 为什么单独一个文件：这三个值任意一个变了，用户数据就会"凭空消失"——
 * 不是真的丢了，而是应用去另一个地方找了。这类 bug 极难查，所以把它们集中钉在这里，
 * 并在 README 里写明改动的后果。
 */

/**
 * 应用身份 = userData 目录名。
 *
 * Electron 默认用 package.json 的 name / productName 推导 userData：
 * 开发时跑 `electron desktop` 得到的是 `qingyin-player-desktop`，
 * 打包后（productName 是中文）得到的是 `轻音播放`——
 * **两个目录，IndexedDB 不通用**，用户装完正式版会发现"曲库没了"。
 * 所以 main.js / probe.js 都在 app ready 之前显式把 userData 钉死成这个名字。
 */
const APP_ID = 'qingyin-player';

/** 窗口标题与托盘提示用的中文名。 */
const APP_NAME = '轻音播放';

/** 只监听回环地址：静态服务不该被局域网里别的机器看到。 */
const LOOPBACK = '127.0.0.1';

/**
 * 固定端口（方案 a 的 origin 一半）。
 *
 * **必须是常量，不能"端口被占用就换一个"**：origin = scheme + host + port，
 * 换端口等于换 origin，Chromium 会认为这是另一个站点，IndexedDB 从零开始，
 * 用户看到的现象就是"曲库和上次播到哪儿全没了"。
 * 端口真的被别人占了，正确行为是**报错退出**，而不是悄悄换端口。
 */
const PORT = 53140;

/** 方案 a 的 origin（渲染进程真正加载的地址）。 */
const ORIGIN = `http://${LOOPBACK}:${PORT}`;

/**
 * 方案 b：自定义协议。
 *
 * 本任务里它只作为**对照实验**存在（probe.js --origin=app），用来实测
 * "app:// 上 IndexedDB 到底能不能持久化"。正式选型结论见 README。
 */
const APP_SCHEME = 'app';
const APP_HOST = 'qingyin';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** 前端构建产物目录（相对仓库根）。desktop/ 是它的兄弟目录。 */
const DIST_DIRNAME = 'dist';

/** 探测"这个端口上跑的是不是我们自己"的魔术路径（单实例判断要用）。 */
const PING_PATH = '/__qingyin__/ping';

/** 探路阶段用来验证 contextBridge 二进制通道的 IPC 通道名。 */
const IPC_ECHO_BYTES = 'desktop:echo-bytes';
const IPC_INFO = 'desktop:info';

module.exports = {
  APP_ID,
  APP_NAME,
  LOOPBACK,
  PORT,
  ORIGIN,
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  DIST_DIRNAME,
  PING_PATH,
  IPC_ECHO_BYTES,
  IPC_INFO,
};
