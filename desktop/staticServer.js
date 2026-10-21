'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { APP_ID, LOOPBACK, PING_PATH, PORT } = require('./constants.js');
const { cacheControlFor, isInside, mimeOf, parseRange } = require('./httpUtils.js');

/**
 * 只服务 `dist/` 的本地静态服务（方案 a）。
 *
 * 存在的唯一理由：给渲染进程一个**真实且永久不变**的 origin（`http://127.0.0.1:53140`），
 * 这样 IndexedDB / localStorage / Service Worker 的行为与浏览器版完全一致。
 * 用 `file://` 加载会让 origin 变成 opaque（null），IndexedDB 直接不可用——那是致命的。
 *
 * 三条安全底线：
 *  1. 只 bind 127.0.0.1，局域网里别的机器看不到
 *  2. Host 头必须是回环地址，挡掉 DNS rebinding（外部域名解析到 127.0.0.1 后拿我们的文件）
 *  3. 只能读 `dist/` 里的文件，路径穿越一律 403
 */

/** 每次启动随机生成：用来判断"端口上跑的是不是我们自己"。 */
function newLaunchToken() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * @param {object} options
 * @param {string} options.root 要服务的目录（dist 的绝对路径）
 * @param {number} [options.port]
 * @param {(event: {level: string, message: string}) => void} [options.onLog]
 */
function createStaticServer(options) {
  const root = path.resolve(options.root);
  const port = options.port ?? PORT;
  const onLog = options.onLog ?? (() => {});
  const token = newLaunchToken();

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      onLog({ level: 'error', message: `静态服务异常：${error instanceof Error ? error.stack : String(error)}` });
      if (!response.headersSent) response.writeHead(500).end('internal error');
      else response.destroy();
    });
  });

  async function handle(request, response) {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const host = request.headers.host ?? '';
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) {
      response.writeHead(403).end('forbidden host');
      return;
    }

    const url = new URL(request.url ?? '/', `http://${LOOPBACK}:${port}`);

    if (url.pathname === PING_PATH) {
      const body = Buffer.from(JSON.stringify({ ok: true, app: APP_ID, token, pid: process.pid }));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      response.end(method === 'HEAD' ? undefined : body);
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end('bad path');
      return;
    }
    if (pathname.includes('\0')) {
      response.writeHead(400).end('bad path');
      return;
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const target = path.join(root, pathname);
    if (!isInside(root, target)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    let info;
    try {
      info = await fsp.stat(target);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    if (!info.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    const relative = path.relative(root, target);
    const headers = {
      'Content-Type': mimeOf(target),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControlFor(relative),
      'Last-Modified': info.mtime.toUTCString(),
    };

    const range = parseRange(request.headers.range, info.size);
    if (range && range.unsatisfiable) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }

    if (range) {
      const { start, end } = range;
      response.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Content-Length': String(end - start + 1),
      });
      if (method === 'HEAD') {
        response.end();
        return;
      }
      fs.createReadStream(target, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(target).pipe(response);
  }

  return {
    token,
    port,
    origin: `http://${LOOPBACK}:${port}`,

    /**
     * 开始监听。
     *
     * 端口被占用时**不换端口**（换了就等于换 origin，用户数据看起来会消失），
     * 而是把 EADDRINUSE 原样抛出去，由调用方决定是提示用户还是退出。
     */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve({ origin: `http://${LOOPBACK}:${port}`, port, token });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, LOOPBACK);
      });
    },

    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { createStaticServer, newLaunchToken };
