'use strict';

/**
 * 轻音播放 · 界面层静态一致性检查
 * 运行：node --test demo/ui-check.cjs
 *
 * 为什么需要它：
 *   Demo 是 file:// 直接打开的静态页面，没有构建步骤，也没有 jsdom 环境，
 *   因此界面无法做真实渲染测试。但界面层最容易犯的错误是"引用了不存在的东西"：
 *   id 拼错、类名与样式不一致、调用了未导出的 API。这类错误在浏览器里往往
 *   只是静默失效（点不动、没反应），很难发现，却能在这里被确定性捕获。
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('./core.js');

const DIR = __dirname;

function read(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}

function matchAll(text, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) out.push(m[1]);
  return out;
}

const html = read('index.html');
const app = read('app.js');
const css = read('style.css');

test('index.html 中的 id 唯一', () => {
  const ids = matchAll(html, /\bid="([^"]+)"/g);
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(duplicated, [], '存在重复 id：' + duplicated.join(', '));
  assert.ok(ids.length >= 30, '页面元素数量异常偏少，实际 ' + ids.length);
});

test('app.js 引用的 DOM id 全部存在于 index.html', () => {
  const htmlIds = new Set(matchAll(html, /\bid="([^"]+)"/g));
  const used = matchAll(app, /\$\('([^']+)'\)/g);
  const missing = [...new Set(used.filter((id) => !htmlIds.has(id)))];

  assert.deepEqual(missing, [], 'app.js 引用了不存在的 id：' + missing.join(', '));
  assert.ok(used.length >= 30, 'app.js 获取的 DOM 节点数量异常偏少，实际 ' + used.length);
});

test('index.html 引用的本地资源都存在', () => {
  ['core.js', 'app.js', 'style.css'].forEach((file) => {
    assert.ok(fs.existsSync(path.join(DIR, file)), file + ' 不存在');
    assert.ok(html.includes(file), 'index.html 未引用 ' + file);
  });
});

test('app.js 用到的 core API 均已导出', () => {
  const used = [...new Set(matchAll(app, /\bC\.([A-Za-z_][A-Za-z0-9_]*)/g))];
  const missing = used.filter((name) => !(name in core));

  assert.deepEqual(missing, [], 'core.js 未导出：' + missing.join(', '));
  assert.ok(used.length >= 8, 'app.js 应实际复用 core 的纯逻辑，当前只用到 ' + used.length + ' 项');
});

test('app.js 操作的样式类都在 style.css 中定义', () => {
  const used = [...new Set(matchAll(app, /classList\.(?:add|remove|toggle)\('([^']+)'/g))];
  const missing = used.filter((cls) => !css.includes('.' + cls));

  assert.deepEqual(missing, [], 'style.css 缺少这些类的定义：' + missing.join(', '));
  assert.ok(used.length >= 4, 'app.js 应通过类名驱动状态样式');
});

test('index.html 中出现的组件类名都有样式定义', () => {
  // 只检查页面里显式写出的 class，用于发现"写了类名但忘了写样式"的情况
  const declared = new Set(matchAll(html, /class="([^"]+)"/g).flatMap((v) => v.split(/\s+/)));
  const allowlist = new Set(['ico']); // 由 JS 注入的 SVG 复用类，单独在样式中已定义
  const missing = [...declared].filter((cls) => cls && !allowlist.has(cls) && !css.includes('.' + cls));

  assert.deepEqual(missing, [], 'index.html 使用了未定义样式的类：' + missing.join(', '));
});
