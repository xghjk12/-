'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { desktopRuntimeFiles, nonRuntimePatterns } = require('../build/desktopRuntimeFiles.js');

/**
 * 打包白名单的防线。
 *
 * 这一组测试存在的理由：**打包漏文件是"装完打不开"级别的故障**，而且它不会在
 * 开发形态暴露（开发时所有文件都在仓库里）。所以这里不信任白名单，而是
 * 从入口出发按 `require('./x')` 递归走一遍依赖图，要求每一个走到的文件都在白名单里。
 * 将来谁给 main.js 加了新模块却忘了加白名单，`pnpm verify` 立刻红。
 */

const desktopDir = path.resolve(__dirname);

/** 抓出一个 CommonJS 文件里所有 `require('./...')` 的相对路径。 */
function localRequires(file) {
  const source = fs.readFileSync(file, 'utf8');
  const found = new Set();
  // 只抓相对路径；'electron' / 'node:fs' 这类内置模块不是我们的文件
  for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/** 解析相对 require → 真实文件（补 .js / package.json 的 main）。 */
function resolveLocal(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec);
  const candidates = [target, `${target}.js`, `${target}.cjs`, path.join(target, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 从入口递归收集所有会被加载的本地文件（相对 desktop/ 的 POSIX 路径）。 */
function collectRuntimeGraph(entry) {
  const seen = new Set();
  const queue = [path.join(desktopDir, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    const rel = path.relative(desktopDir, file).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of localRequires(file)) {
      const resolved = resolveLocal(file, spec);
      if (!resolved) {
        // 解析不到时留一条 @missing 记录，让断言能报出来而不是静默跳过
        seen.add(`@missing:${rel}->${spec}`);
        continue;
      }
      const childRel = path.relative(desktopDir, resolved).split(path.sep).join('/');
      if (!seen.has(childRel)) queue.push(resolved);
    }
  }
  return [...seen].filter(Boolean);
}

/**
 * 白名单里刻意排除、但入口仍会在**某条分支**上 require 的文件。
 *
 * 这类分支必须由 `existsSync` 之类守卫住（打包后文件不存在就走另一条路），
 * 否则装好的软件会在某个参数组合下直接崩。下面的测试同时校验两件事：
 *   1. 这些文件确实不在白名单里（避免有人"顺手"加回去）；
 *   2. 引用它的地方确实有守卫。
 */
const GUARDED_OPTIONAL = Object.freeze([
  {
    file: 'probe.js',
    referencedBy: 'entry.js',
    guard: /existsSync/,
    why: '开发期 origin 探路脚本，产品不需要',
  },
]);

test('白名单里每个文件都真的存在', () => {
  const missing = desktopRuntimeFiles.filter(
    (file) => !fs.existsSync(path.join(desktopDir, file.split('/').join(path.sep))),
  );
  assert.deepEqual(missing, [], `白名单里有文件不存在：${missing.join(', ')}`);
});

test('入口递归依赖图里的每个文件都在白名单里（漏加会装完打不开）', () => {
  const graph = collectRuntimeGraph('entry.js');
  const whitelist = new Set(desktopRuntimeFiles);
  const guarded = new Set(GUARDED_OPTIONAL.map((item) => item.file));

  const missingFromWhitelist = graph.filter((rel) => rel.startsWith('@missing:'));
  assert.deepEqual(missingFromWhitelist, [], `有 require 指向的文件不存在：${missingFromWhitelist.join(', ')}`);

  // 有守卫的可选文件被排除是**故意**的，其余一律必须在白名单里
  const notCovered = graph.filter((rel) => !whitelist.has(rel) && !guarded.has(rel));
  assert.deepEqual(
    notCovered,
    [],
    `这些文件会被运行期加载但没进打包白名单（用户装完会启动失败）：\n  ${notCovered.join('\n  ')}\n` +
      '把它们加进 build/desktopRuntimeFiles.js 的 desktopRuntimeFiles',
  );
});

test('被排除的可选文件不能"顺手"加回白名单', () => {
  const whitelist = new Set(desktopRuntimeFiles);
  for (const item of GUARDED_OPTIONAL) {
    assert.equal(
      whitelist.has(item.file),
      false,
      `${item.file} 不该进包（${item.why}），但它出现在白名单里了`,
    );
  }
});

test('引用被排除文件的地方必须有 existsSync 守卫（否则装好的软件会崩）', () => {
  for (const item of GUARDED_OPTIONAL) {
    const referrer = path.join(desktopDir, item.referencedBy);
    const source = fs.readFileSync(referrer, 'utf8');
    // 找到**真正执行**的 require 那一行（跳过注释里提到的名字，那不算引用）
    const lines = source.split('\n');
    const index = lines.findIndex((line) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//')) return false;
      return code.includes(`require('./${item.file}')`);
    });
    assert.notEqual(
      index,
      -1,
      `${item.referencedBy} 里找不到对 ${item.file} 的 require（注释里的不算）`,
    );
    // 守卫可以在同一行（`if (... existsSync ...)`) 或紧邻上方几行
    const context = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
    assert.match(
      context,
      item.guard,
      `${item.referencedBy} 里 require('./${item.file}') 没有 existsSync 守卫——` +
        '打包后该文件不存在，走这条路会直接崩。\n上下文：\n' +
        context,
    );
  }
});

test('白名单里没有测试/验收/探针脚本（它们不该进用户的软件）', () => {
  const offenders = desktopRuntimeFiles.filter((file) => {
    const base = file.split('/').pop();
    return nonRuntimePatterns.some((pattern) => pattern.test(base));
  });
  assert.deepEqual(offenders, [], `这些文件不该打包：${offenders.join(', ')}`);
});

test('打包配置引用的图标文件存在', () => {
  // 少一个图标 electron-builder 会直接失败，或者产出一个白板快捷方式
  for (const icon of ['public/icons/icon.ico', 'public/icons/icon-192.png']) {
    const full = path.resolve(desktopDir, '..', icon.split('/').join(path.sep));
    assert.equal(fs.existsSync(full), true, `缺少打包图标：${icon}（跑 node scripts/make-icons.mjs）`);
  }
});

test('.ico 结构合法（多尺寸，每个条目内嵌 PNG）', () => {
  const icoPath = path.resolve(desktopDir, '..', 'public', 'icons', 'icon.ico');
  const buffer = fs.readFileSync(icoPath);

  assert.equal(buffer.readUInt16LE(0), 0, '保留字段应为 0');
  assert.equal(buffer.readUInt16LE(2), 1, '类型应为 1（图标）');
  const count = buffer.readUInt16LE(4);
  assert.ok(count >= 5, `应该有多档尺寸（实际 ${count} 档）`);

  // 把每个条目指的 PNG 数据切出来，核对 PNG 魔术字节与声明的偏移/长度
  for (let i = 0; i < count; i += 1) {
    const entryOffset = 6 + i * 16;
    const bytes = buffer.readUInt32LE(entryOffset + 8);
    const offset = buffer.readUInt32LE(entryOffset + 12);
    assert.ok(offset + bytes <= buffer.length, `第 ${i} 张的偏移越界`);
    const slice = buffer.subarray(offset, offset + bytes);
    assert.deepEqual(
      [...slice.subarray(0, 4)],
      [0x89, 0x50, 0x4e, 0x47],
      `第 ${i} 张不是 PNG（Windows 读不了会让图标显示空白）`,
    );
  }
});
