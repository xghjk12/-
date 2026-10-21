'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * preload：渲染进程能碰到的**全部**桌面能力都从这里出去。
 *
 * 规矩（这几条是安全边界，不是风格偏好）：
 *  - `contextIsolation: true` + `sandbox: true`，不开 nodeIntegration
 *  - 只暴露函数与可结构化克隆的数据，绝不把 `ipcRenderer` / `require` / `process` 交出去
 *  - 暴露的对象会被冻结，渲染进程改不了
 *
 * 现在这里只有两个"探路用"的方法（info / echoBytes）：
 *  - `info` 证明 contextBridge 通路是活的，并且把 origin、版本号这些环境事实交给页面
 *  - `echoBytes` 回答一个必须先知道答案的问题：**Uint8Array 能不能原样穿过 contextBridge**。
 *    fs 桥要传音频文件头与 .lrc 原始字节（歌词编码判断依赖原始字节，不能提前 decode 成字符串），
 *    如果二进制通道不通，整个 `ByteSource` 设计就得改。
 *
 * 真正的 fs 桥（pickFolder / listFolder / readRange / readWhole / media.url）
 * **只在 README 里设计，本任务不实现**，形状见文件末尾的注释。
 */

const api = {
  info: () => ipcRenderer.invoke('desktop:info'),
  echoBytes: (length) => ipcRenderer.invoke('desktop:echo-bytes', length),
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
