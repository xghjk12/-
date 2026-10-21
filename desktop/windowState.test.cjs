'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_VISIBLE_PX,
  sanitizeWindowState,
  isOnDisplays,
  centeredIn,
  resolveStartupWindow,
  captureWindowState,
  createDebouncedSaver,
} = require('./windowState.js');
const {
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} = require('./constants.js');

/** 一块 1920x1080 的主屏（工作区比物理屏矮一点，模拟任务栏）。 */
const PRIMARY = { isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
/** 主屏右边接一块副屏（x 从 1920 开始）。 */
const SECONDARY = { workArea: { x: 1920, y: 0, width: 1600, height: 900 } };
const BOTH = [PRIMARY, SECONDARY];

// ---------------------------------------------------------------- 规范化

test('合法几何原样保留（坐标取整）', () => {
  assert.deepEqual(sanitizeWindowState({ x: 100.4, y: 80.6, width: 1200, height: 800, maximized: false }), {
    x: 100,
    y: 81,
    width: 1200,
    height: 800,
    maximized: false,
  });
});

test('maximized 只认 ===true', () => {
  assert.equal(sanitizeWindowState({ x: 0, y: 0, width: 1000, height: 700, maximized: 'yes' }).maximized, false);
  assert.equal(sanitizeWindowState({ x: 0, y: 0, width: 1000, height: 700, maximized: true }).maximized, true);
});

test('x/y 允许 null（= 记住尺寸、位置交给系统居中）', () => {
  assert.deepEqual(sanitizeWindowState({ x: null, y: null, width: 1000, height: 700 }), {
    x: null,
    y: null,
    width: 1000,
    height: 700,
    maximized: false,
  });
});

test('尺寸不合法 → 整个丢弃（不做半合法妥协）', () => {
  const bad = [
    null,
    undefined,
    'nope',
    [],
    { x: 0, y: 0 },                                  // 没有尺寸
    { x: 0, y: 0, width: 0, height: 0 },             // 零尺寸
    { x: 0, y: 0, width: WINDOW_MIN_WIDTH - 1, height: 800 },   // 比最小宽度还窄
    { x: 0, y: 0, width: 1200, height: WINDOW_MIN_HEIGHT - 1 }, // 比最小高度还矮
    { x: 0, y: 0, width: 40000, height: 800 },       // 超出坐标极限
    { x: 0, y: 0, width: '1200', height: 800 },      // 字符串尺寸
    { x: 0, y: 0, width: NaN, height: 800 },
    { x: 99999, y: 0, width: 1200, height: 800 },    // 坐标超出极限
  ];
  for (const input of bad) {
    assert.equal(sanitizeWindowState(input), null, `${JSON.stringify(input)} 应该被判为不合法`);
  }
});

test('负坐标是合法的（副屏在主屏左边/上面时就会出现）', () => {
  assert.deepEqual(sanitizeWindowState({ x: -1600, y: -200, width: 1200, height: 800 }), {
    x: -1600,
    y: -200,
    width: 1200,
    height: 800,
    maximized: false,
  });
});

// ---------------------------------------------------------------- 屏幕内校验

test('完全在主屏里 → 看得见', () => {
  assert.equal(isOnDisplays({ x: 100, y: 100, width: 1200, height: 800 }, [PRIMARY]), true);
});

test('在副屏里 → 看得见（多显示器场景不能误判成屏幕外）', () => {
  assert.equal(isOnDisplays({ x: 2000, y: 100, width: 1200, height: 800 }, BOTH), true);
});

test('拔掉副屏后，同一坐标就变成屏幕外（这就是要防的那个 bug）', () => {
  assert.equal(isOnDisplays({ x: 2000, y: 100, width: 1200, height: 800 }, [PRIMARY]), false);
});

test('只露出一点点不算看得见：必须两个方向都至少露出 MIN_VISIBLE_PX', () => {
  // 右边缘只压进主屏 40px
  assert.equal(isOnDisplays({ x: 1920 - 40, y: 100, width: 1200, height: 800 }, [PRIMARY]), false);
  // 露出足够宽度但只露 10px 高度（标题栏都抓不到）
  assert.equal(isOnDisplays({ x: 100, y: 1040 - 10, width: 1200, height: 800 }, [PRIMARY]), false);
  // 两个方向都露出 MIN_VISIBLE_PX 以上 → 可以
  assert.equal(isOnDisplays({ x: 1920 - MIN_VISIBLE_PX, y: 100, width: 1200, height: 800 }, [PRIMARY]), true);
  assert.equal(MIN_VISIBLE_PX, 120);
});

test('极端屏幕外坐标（Windows 最小化时常见的 -32000）→ 看不见', () => {
  assert.equal(isOnDisplays({ x: -32000, y: -32000, width: 1200, height: 800 }, BOTH), false);
});

test('窗口本身比 MIN_VISIBLE_PX 还小时，按"整块都在屏幕里"判定', () => {
  assert.equal(isOnDisplays({ x: 1920 - 50, y: 100, width: 50, height: 50 }, [PRIMARY]), true);
  assert.equal(isOnDisplays({ x: 1920 - 10, y: 100, width: 50, height: 50 }, [PRIMARY]), false);
});

test('显示器列表为空/畸形 → 一律判为看不见（宁可回退居中，不要放一个找不到的窗口出去）', () => {
  assert.equal(isOnDisplays({ x: 0, y: 0, width: 1200, height: 800 }, []), false);
  assert.equal(isOnDisplays({ x: 0, y: 0, width: 1200, height: 800 }, null), false);
  assert.equal(isOnDisplays({ x: 0, y: 0, width: 1200, height: 800 }, [{ workArea: null }]), false);
  assert.equal(isOnDisplays(null, [PRIMARY]), false);
});

test('裸矩形也能当显示器用（workArea / bounds / 直接给矩形三种写法都认）', () => {
  assert.equal(isOnDisplays({ x: 10, y: 10, width: 800, height: 600 }, [{ x: 0, y: 0, width: 1920, height: 1040 }]), true);
  assert.equal(isOnDisplays({ x: 10, y: 10, width: 800, height: 600 }, [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]), true);
});

test('居中：窗口比屏幕大时缩到屏幕大小，且不会算出负偏移', () => {
  const small = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(centeredIn(small, 400, 300), { x: 200, y: 150, width: 400, height: 300 });

  // 请求的尺寸远超屏幕 → 缩到屏幕大小，偏移是 0 而不是负数
  assert.deepEqual(centeredIn(small, 4000, 3000), { x: 0, y: 0, width: 800, height: 600 });
});

test('居中：副屏上的居中要算上那块屏的原点偏移', () => {
  assert.deepEqual(centeredIn({ x: 1920, y: 0, width: 1600, height: 900 }, 1200, 800), {
    x: 2120,
    y: 50,
    width: 1200,
    height: 800,
  });
});

// ---------------------------------------------------------------- 启动时选几何

test('首次启动（没有已保存状态）→ 主屏居中 + 默认尺寸', () => {
  const result = resolveStartupWindow({ saved: null, displays: [PRIMARY] });
  assert.equal(result.source, 'default');
  assert.equal(result.maximized, false);
  assert.deepEqual(result.bounds, {
    x: Math.round((1920 - WINDOW_DEFAULT_WIDTH) / 2),
    y: Math.round((1040 - WINDOW_DEFAULT_HEIGHT) / 2),
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
  });
  assert.equal(isOnDisplays(result.bounds, [PRIMARY]), true);
});

test('已保存且在屏幕内 → 原样沿用', () => {
  const saved = { x: 123, y: 456, width: 1100, height: 750, maximized: false };
  const result = resolveStartupWindow({ saved, displays: BOTH });
  assert.equal(result.source, 'saved');
  // bounds 只含几何，maximized 是平级的另一个字段
  assert.deepEqual(result.bounds, { x: 123, y: 456, width: 1100, height: 750 });
  assert.equal(result.maximized, false);
  assert.match(result.reason, /沿用/);
});

test('已保存但在屏幕外（副屏被拔）→ 回退主屏居中，并把原因写进 reason', () => {
  const saved = { x: 2500, y: 300, width: 1100, height: 750, maximized: false };
  const result = resolveStartupWindow({ saved, displays: [PRIMARY] });
  assert.equal(result.source, 'default');
  assert.match(result.reason, /不在任何屏幕/);
  assert.equal(isOnDisplays(result.bounds, [PRIMARY]), true, '回退之后必须在屏幕内');
  assert.deepEqual(result.bounds, {
    x: Math.round((1920 - WINDOW_DEFAULT_WIDTH) / 2),
    y: Math.round((1040 - WINDOW_DEFAULT_HEIGHT) / 2),
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
  });
});

test('副屏还在时，同一份存档就该沿用（回退只在真越界时发生）', () => {
  const saved = { x: 2500, y: 300, width: 1100, height: 750, maximized: false };
  assert.equal(resolveStartupWindow({ saved, displays: BOTH }).source, 'saved');
});

test('只记住尺寸没记住位置 → 主屏居中，尺寸沿用', () => {
  const result = resolveStartupWindow({
    saved: { x: null, y: null, width: 1100, height: 750, maximized: false },
    displays: [PRIMARY],
  });
  assert.equal(result.source, 'saved-centered');
  assert.equal(result.bounds.width, 1100);
  assert.equal(result.bounds.height, 750);
  assert.equal(isOnDisplays(result.bounds, [PRIMARY]), true);
});

test('最大化状态在回退时也要保留（还原之后用的是回退后的几何）', () => {
  const result = resolveStartupWindow({
    saved: { x: 2500, y: 300, width: 1100, height: 750, maximized: true },
    displays: [PRIMARY],
  });
  assert.equal(result.source, 'default');
  assert.equal(result.maximized, true);
});

test('没指定 primaryDisplay 时优先认 isPrimary，其次认第一块', () => {
  const saved = null;
  const byFlag = resolveStartupWindow({ saved, displays: [SECONDARY, PRIMARY] });
  assert.equal(byFlag.bounds.x, Math.round((1920 - WINDOW_DEFAULT_WIDTH) / 2), '应该居中在 isPrimary 那块');

  const byFirst = resolveStartupWindow({ saved, displays: [SECONDARY] });
  assert.equal(byFirst.bounds.x, Math.round(1920 + (1600 - WINDOW_DEFAULT_WIDTH) / 2));
});

test('一块屏幕都读不到 → 尺寸用默认值，位置交给系统（x/y 为 null）', () => {
  const result = resolveStartupWindow({ saved: null, displays: [] });
  assert.equal(result.source, 'default');
  assert.equal(result.bounds.x, null);
  assert.equal(result.bounds.y, null);
  assert.equal(result.bounds.width, WINDOW_DEFAULT_WIDTH);
  assert.match(result.reason, /读不到任何显示器/);
});

// ---------------------------------------------------------------- 抓取当前几何

function fakeWindow(overrides = {}) {
  return {
    destroyed: false,
    minimized: false,
    maximized: false,
    bounds: { x: 100, y: 100, width: 1200, height: 800 },
    normalBounds: { x: 90, y: 90, width: 1100, height: 750 },
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isMaximized() {
      return this.maximized;
    },
    getBounds() {
      return { ...this.bounds };
    },
    getNormalBounds() {
      return { ...this.normalBounds };
    },
    ...overrides,
  };
}

test('普通窗口：抓 getBounds，坐标取整', () => {
  assert.deepEqual(captureWindowState(fakeWindow({ bounds: { x: 100.6, y: 99.2, width: 1200, height: 800 } })), {
    x: 101,
    y: 99,
    width: 1200,
    height: 800,
    maximized: false,
  });
});

test('最大化时抓 getNormalBounds（否则还原后会得到一个和屏幕一样大的窗口）', () => {
  const captured = captureWindowState(fakeWindow({ maximized: true }));
  assert.equal(captured.maximized, true);
  assert.deepEqual(
    { x: captured.x, y: captured.y, width: captured.width, height: captured.height },
    { x: 90, y: 90, width: 1100, height: 750 },
  );
});

test('最小化 / 已销毁 / 传错东西 → null（那时的几何没有意义）', () => {
  assert.equal(captureWindowState(fakeWindow({ minimized: true })), null);
  assert.equal(captureWindowState(fakeWindow({ destroyed: true })), null);
  assert.equal(captureWindowState(null), null);
  assert.equal(captureWindowState({}), null);
});

test('最小化时窗口报的是 -32000：绝不能把它存下来', () => {
  const minimized = fakeWindow({ minimized: true, bounds: { x: -32000, y: -32000, width: 1200, height: 800 } });
  assert.equal(captureWindowState(minimized), null);
});

// ---------------------------------------------------------------- 防抖写盘

/** 手动推进的假定时器：测试里不真的等 600ms。 */
function fakeTimers() {
  const queue = [];
  let seq = 0;
  return {
    setTimeoutImpl(fn, delay) {
      seq += 1;
      queue.push({ id: seq, fn, delay });
      return seq;
    },
    clearTimeoutImpl(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    /** 把所有到期的回调跑掉（模拟时间走完）。 */
    tick() {
      while (queue.length > 0) {
        const item = queue.shift();
        item.fn();
      }
    },
    pending: () => queue.length,
  };
}

test('防抖：连续 50 次像素变动只写一次盘，写的是最后一次的几何', () => {
  const timers = fakeTimers();
  const written = [];
  const saver = createDebouncedSaver({ save: (state) => written.push(state), delayMs: 600, ...timers });

  for (let index = 0; index < 50; index += 1) {
    saver.schedule({ x: index, y: 0, width: 1200, height: 800, maximized: false });
  }
  assert.deepEqual(written, [], '防抖窗口内不该写盘');
  assert.equal(timers.pending(), 1, '只挂一个定时器，不是每次变动都挂一个');

  timers.tick();
  assert.equal(written.length, 1);
  assert.equal(written[0].x, 49, '写的是最后一次的位置');
  assert.deepEqual(saver.stats(), { writes: 1, scheduled: 50, skippedIdentical: 0, pending: false });
});

test('去重：几何没变就不写（避免无意义的磁盘写入）', () => {
  const timers = fakeTimers();
  const written = [];
  const saver = createDebouncedSaver({ save: (state) => written.push(state), ...timers });
  const state = { x: 10, y: 10, width: 1200, height: 800, maximized: false };

  saver.schedule(state);
  timers.tick();
  saver.schedule({ ...state });
  timers.tick();
  assert.equal(written.length, 1);
  assert.equal(saver.stats().skippedIdentical, 1);

  saver.schedule({ ...state, x: 11 });
  timers.tick();
  assert.equal(written.length, 2, '真的变了就要写');
});

test('flush：退出前能把待写内容立刻落盘（真退出路径靠它兜底）', () => {
  const timers = fakeTimers();
  const written = [];
  const saver = createDebouncedSaver({ save: (state) => written.push(state), ...timers });

  saver.schedule({ x: 5, y: 5, width: 1000, height: 700, maximized: false });
  assert.equal(saver.flush(), true);
  assert.equal(written.length, 1);
  assert.equal(timers.pending(), 0, 'flush 之后定时器要清掉，不能稍后再写一次');
  assert.equal(saver.flush(), false, '没有待写内容时 flush 返回 false');
});

test('cancel：丢掉待写内容（窗口已销毁时用）', () => {
  const timers = fakeTimers();
  const written = [];
  const saver = createDebouncedSaver({ save: (state) => written.push(state), ...timers });

  saver.schedule({ x: 5, y: 5, width: 1000, height: 700, maximized: false });
  saver.cancel();
  timers.tick();
  assert.deepEqual(written, []);
  assert.equal(saver.stats().pending, false);
});

test('schedule(null) 是空操作（最小化时抓不到几何）', () => {
  const timers = fakeTimers();
  const written = [];
  const saver = createDebouncedSaver({ save: (state) => written.push(state), ...timers });
  saver.schedule(null);
  timers.tick();
  assert.deepEqual(written, []);
  assert.equal(saver.stats().scheduled, 0);
});
