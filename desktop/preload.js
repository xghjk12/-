'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * preload：渲染进程能碰到的**全部**桌面能力都从这里出去。
 *
 * 规矩（这几条是安全边界，不是风格偏好）：
 *  - `contextIsolation: true` + `sandbox: true`，不开 nodeIntegration
 *  - 只暴露函数与可结构化克隆的数据，绝不把 `ipcRenderer` / `require` / `process` 交出去
 *  - 暴露的对象会被冻结，渲染进程改不了
 *
 * 现在有三组能力：
 *  - `info` / `echoBytes`：探路用的环境事实与二进制通道验证（t1）
 *  - `lyrics.getTrackPath`：`webUtils.getPathForFile`——渲染进程的 `File` 反查
 *    绝对路径（t5 的曲库根目录反推依赖它；File 对象可以穿过 contextBridge
 *    当参数传，这是 Electron 官方文档给的用法）
 *  - `lyrics.run/status/cancel/onStatus/onFillRequested`：外部补歌词工具的
 *    执行通道（t5，主进程 spawn powershell，无 shell、纯 argv 数组）
 */

const api = {
  info: () => ipcRenderer.invoke('desktop:info'),
  echoBytes: (length) => ipcRenderer.invoke('desktop:echo-bytes', length),
  lyrics: {
    /**
     * 渲染进程拿到某个音频 `File`（来自 FileSystemDirectoryHandle.getFile()）
     * 后反查它在磁盘上的绝对路径。**t5 实测（desktop/checkPathForFile.js）：
     * 句柄来源的 File 返回空串**——Electron 的 webUtils 只认拖拽/file-input
     * 背书的 File。保留这个入口是为了：①如果以后换了曲库来源（input 回退路）
     * 可以直接用；②假 File 也返回空串这条行为有据可查。
     */
    getTrackPath: (file) => webUtils.getPathForFile(file),
    /** 触发一次补歌词（路径由主进程解析：存档的 musicFolderPath 或弹目录对话框）。 */
    run: () => ipcRenderer.invoke('lyrics:run'),
    /** 当前工具执行状态：{ status, exitCode, tail, ... }。 */
    status: () => ipcRenderer.invoke('lyrics:status'),
    /** 取消正在跑的工具（杀整棵进程树）。 */
    cancel: () => ipcRenderer.invoke('lyrics:cancel'),
    /** 订阅状态推送（idle|running|done|failed + 日志尾），返回取消订阅函数。 */
    onStatus: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('lyrics:status-changed', listener);
      return () => ipcRenderer.removeListener('lyrics:status-changed', listener);
    },
  },
};

contextBridge.exposeInMainWorld('qingyinDesktop', api);

/*
 * ==== fs 桥的目标形状（设计，见 desktop/README.md 第 4 节）====
 *
 * contextBridge.exposeInMainWorld('qingyinDesktop', {
 *   info: { ... },                                   // 只读环境事实
 *   fs: {
 *     pickFolder(): Promise<{canceled, root?, rootName?}>,
 *     listFolder(root, requestId): Promise<{audio: Entry[], lyrics: Entry[]}>,  // 一次遍历，两张表
 *     onListProgress(requestId, cb): () => void,       // 返回取消订阅函数
 *     readRange(root, path, start, end): Promise<Uint8Array>,   // 给 ByteSource.read 用
 *     readWhole(root, path): Promise<Uint8Array>,               // 给 .lrc 用
 *   },
 *   media: { url(root, path): string },               // 只拼 URL，不做 IO
 * });
 */
