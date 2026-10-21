'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { protocol } = require('electron');
const { APP_HOST, APP_SCHEME } = require('./constants.js');
const { isInside, mimeOf } = require('./httpUtils.js');

/**
 * 方案 b：`app://` 自定义协议（本任务里只作**对照实验**用）。
 *
 * 两个函数必须分开调用：
 *  - `registerAppSchemePrivileges()` 要在 **app ready 之前**调用，
 *    因为 Chromium 在启动时就决定了某个 scheme 是不是"标准 / 安全上下文"，
 *    ready 之后再改无效。standard 让 `app://qingyin/index.html` 里的相对路径按目录解析，
 *    secure 让这个 origin 算作安全上下文（IndexedDB / crypto.subtle 之类才可用）。
 *  - `installAppProtocolHandler()` 要在 **app ready 之后**调用，protocol 模块那时才可用。
 *
 * 已知短板（选型时会用到）：自定义协议不会自动处理 Range 请求，
 * `<audio>` 拖动进度条需要自己解析 Range 并回 206，这里刻意没做——
 * 探路阶段只需要它能加载页面，够用来对比 IndexedDB 行为了。
 */

function registerAppSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

function installAppProtocolHandler(root) {
  const resolvedRoot = path.resolve(root);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) {
      return new Response('not found', { status: 404 });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad path', { status: 400 });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const target = path.join(resolvedRoot, pathname);
    if (!isInside(resolvedRoot, target)) {
      return new Response('forbidden', { status: 403 });
    }

    try {
      const body = await fsp.readFile(target);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': mimeOf(target),
          'Content-Length': String(body.length),
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

module.exports = { registerAppSchemePrivileges, installAppProtocolHandler };
