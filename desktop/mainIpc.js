'use strict';

const { app, ipcMain } = require('electron');
const { APP_ID, IPC_SHELL_STATUS, LOOPBACK, ORIGIN, PORT } = require('./constants.js');

/**
 * 主进程侧的 IPC 处理器（探路阶段只有两个）。
 *
 * `desktop:echo-bytes` 看着像玩具，其实是 fs 桥的**前置验证**：
 * 桥要把音频文件头（16KB 区间）和 `.lrc` 原始字节送到渲染进程，
 * 而歌词编码判断（`core/lyrics.ts` 的 decodeLyrics）依赖"拿到的是原始字节而不是被 decode 过的字符串"。
 * 如果 Uint8Array 穿不过 contextBridge，`ByteSource` 的设计就得改，所以先量一下。
 *
 * t6 又加了一个**单向**通道：`shell:status`（渲染进程 → 主进程的播放状态上报）。
 * 托盘菜单的「播放/暂停」文案和三个播放项的禁用态全靠它，主进程不从别处推断
 * （自动切歌、播完停下这些时刻，猜出来的状态一定是错的）。这里只做转发，
 * 规范化与保存在 playbackStatus.js / main.js。
 *
 * @param {object} [context]
 * @param {(status: unknown) => void} [context.onShellStatus] 收到播放状态上报时的回调
 */
function installDesktopIpc(context = {}) {
  ipcMain.removeHandler('desktop:info');
  ipcMain.handle('desktop:info', () => ({
    appId: APP_ID,
    origin: context.origin ?? ORIGIN,
    loopback: LOOPBACK,
    port: context.port ?? PORT,
    launchToken: context.token ?? null,
    pid: process.pid,
    appName: app.getName(),
    appVersion: app.getVersion(),
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    platform: process.platform,
    arch: process.arch,
    startedAt: context.startedAt ?? null,
  }));

  ipcMain.removeHandler('desktop:echo-bytes');
  ipcMain.handle('desktop:echo-bytes', (_event, length) => {
    const size = Math.max(0, Math.min(1 << 20, Number(length) || 0));
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + 3) & 0xff;
    return bytes;
  });

  // t6：播放状态上报（渲染进程用 ipcRenderer.send，不需要回复，所以不是 handle）。
  // removeAllListeners 是为了让重复装配（测试里可能发生）不会把回调叠成好几层。
  ipcMain.removeAllListeners(IPC_SHELL_STATUS);
  ipcMain.on(IPC_SHELL_STATUS, (_event, status) => {
    if (typeof context.onShellStatus === 'function') context.onShellStatus(status);
  });
}

module.exports = { installDesktopIpc };
