'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const constants = require('./constants.js');

/**
 * IPC 通道名的一致性（静态钉住）。
 *
 * 通道名在三个地方各写了一遍字面量：
 *  - `desktop/constants.js`（主进程用的常量）
 *  - `desktop/preload.js`（sandbox 化的 preload 故意不 require 本地模块，见文件内注释）
 *  - `src/ui/desktopShell.ts`（渲染进程订阅方，跨语言边界拿不到 constants）
 *
 * 拼错一个字母的后果是"托盘点了没反应"，而且不会有任何报错——这类 bug 只能靠
 * 静态比对拦住。所以这里直接把三份源码当文本读，断言字面量对得上。
 */

const DESKTOP_DIR = __dirname;
const REPO_ROOT = path.dirname(DESKTOP_DIR);

function readSource(relativePath) {
  const file = path.join(REPO_ROOT, relativePath);
  assert.ok(fs.existsSync(file), `源文件不存在：${relativePath}`);
  return fs.readFileSync(file, 'utf8');
}

test('constants.js 把两个通道名和命令白名单都导出成常量', () => {
  assert.equal(constants.IPC_SHELL_COMMAND, 'shell:command');
  assert.equal(constants.IPC_SHELL_STATUS, 'shell:status');
  assert.deepEqual([...constants.SHELL_COMMAND_TYPES], ['play-pause', 'prev', 'next']);
  assert.ok(Object.isFrozen(constants.SHELL_COMMAND_TYPES), '白名单要冻结');
});

test('preload.js 里的通道名字面量与 constants.js 完全一致', () => {
  const preload = readSource('desktop/preload.js');
  assert.ok(
    preload.includes(`'${constants.IPC_SHELL_COMMAND}'`),
    `preload.js 里没有 ${constants.IPC_SHELL_COMMAND}（命令收不到，托盘播放控制会静默失效）`,
  );
  assert.ok(
    preload.includes(`'${constants.IPC_SHELL_STATUS}'`),
    `preload.js 里没有 ${constants.IPC_SHELL_STATUS}（状态上报不了，托盘文案会一直停在"播放"）`,
  );
});

test('preload.js 暴露了 onCommand / reportStatus 两个入口，并且 onCommand 返回取消订阅', () => {
  const preload = readSource('desktop/preload.js');
  assert.match(preload, /onCommand:\s*\(callback\)\s*=>/);
  assert.match(preload, /reportStatus:\s*\(status\)\s*=>/);
  assert.match(preload, /ipcRenderer\.removeListener\('shell:command', listener\)/);
});

test('渲染侧订阅文件覆盖了白名单里的每一个命令类型', () => {
  const shell = readSource('src/ui/desktopShell.ts');
  for (const type of constants.SHELL_COMMAND_TYPES) {
    assert.ok(
      shell.includes(`'${type}'`),
      `src/ui/desktopShell.ts 没有处理命令 ${type}（托盘那一项点了会没反应）`,
    );
  }
});

test('渲染侧只调用既有 store 动作，没有自己写播放逻辑', () => {
  const shell = readSource('src/ui/desktopShell.ts');
  for (const action of ['togglePlay', 'previous', 'next']) {
    assert.ok(shell.includes(`store.${action}`), `应该调用 store.${action}()`);
  }
  // 反面断言：接缝文件里不该出现直接操作音频/store 内部状态的写法
  assert.ok(!shell.includes('getAudioElement'), '接缝层不该直接摸 audio 元素');
  assert.ok(!shell.includes('useAppStore.setState'), '接缝层不该写 store 状态');
});

test('渲染侧的上报字段与 preload 过桥的字段是同一组', () => {
  const shell = readSource('src/ui/desktopShell.ts');
  const preload = readSource('desktop/preload.js');
  for (const field of ['playing', 'currentIndex', 'queueLength', 'hasTrack']) {
    assert.ok(shell.includes(field), `src/ui/desktopShell.ts 缺字段 ${field}`);
    assert.ok(preload.includes(field), `desktop/preload.js 缺字段 ${field}`);
  }
});
