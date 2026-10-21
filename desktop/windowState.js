'use strict';

const {
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} = require('./constants.js');

/**
 * 窗口几何：存什么、怎么校验、什么时候写盘。
 *
 * 这个模块存在的唯一理由是**防止把窗口恢复到屏幕外**：多显示器用户拔掉副屏之后，
 * 上次的坐标还留在那块已经不存在的屏幕上，窗口"打开了但看不见"，用户只能靠
 * 托盘菜单救回来（而且他多半不知道有托盘）。所以恢复之前必须拿
 * `screen.getAllDisplays()` 的真实工作区校验一遍，越界就回退到主屏居中默认尺寸。
 *
 * 纯 Node 模块（不 require electron）：`captureWindowState` 只做鸭子类型判断，
 * 传假的窗口对象就能单测（desktop/windowState.test.cjs）。
 */

/** 至少要有这么多像素落在某块屏幕的工作区里，才算"看得见"。 */
const MIN_VISIBLE_PX = 120;

/** resize/move 的防抖窗口：拖动过程中不写盘，停下来才写一次。 */
const DEFAULT_SAVE_DEBOUNCE_MS = 600;

/** Windows 的坐标极限；超过这个数一定是脏数据，不是用户真的把窗口拉那么大。 */
const MAX_COORD = 32768;
const MAX_DIMENSION = 32768;

function roundOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * 规范化落盘的窗口状态。任何字段不合法就整个丢弃（回到 null = 下次用默认值），
 * 不做"半合法"的妥协——半合法的几何会造出更怪的窗口。
 *
 * @param {unknown} raw
 * @returns {{ x: number | null, y: number | null, width: number, height: number, maximized: boolean } | null}
 */
function sanitizeWindowState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const width = roundOrNull(raw.width);
  const height = roundOrNull(raw.height);
  if (width === null || height === null) return null;
  if (width < WINDOW_MIN_WIDTH || width > MAX_DIMENSION) return null;
  if (height < WINDOW_MIN_HEIGHT || height > MAX_DIMENSION) return null;

  // x/y 允许是 null：意思是"尺寸记住，位置交给系统居中"
  const x = roundOrNull(raw.x);
  const y = roundOrNull(raw.y);
  if (x !== null && Math.abs(x) > MAX_COORD) return null;
  if (y !== null && Math.abs(y) > MAX_COORD) return null;

  return { x, y, width, height, maximized: raw.maximized === true };
}

/** 从 Electron 的 Display（或裸矩形）里取出工作区矩形。 */
function workAreaOf(display) {
  const area = display?.workArea ?? display?.bounds ?? display;
  if (!area || typeof area !== 'object') return null;
  const x = roundOrNull(area.x);
  const y = roundOrNull(area.y);
  const width = roundOrNull(area.width);
  const height = roundOrNull(area.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** 两个矩形在 x / y 方向上的重叠长度（不相交就是 0 或负数）。 */
function overlapOf(a, b) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { overlapX, overlapY };
}

/**
 * 窗口矩形是否"看得见"：至少有一块屏幕的工作区与它相交，
 * 且相交部分在两个方向上都不小于 minVisiblePx（或窗口本身比它还小）。
 *
 * 只判"有没有相交"是不够的：窗口露出 1 个像素也算相交，但用户根本抓不到它。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<object>} displays `screen.getAllDisplays()` 的结果（或裸矩形数组）
 * @param {number} [minVisiblePx]
 * @returns {boolean}
 */
function isOnDisplays(bounds, displays, minVisiblePx = MIN_VISIBLE_PX) {
  if (!bounds || !Array.isArray(displays)) return false;
  const rect = {
    x: roundOrNull(bounds.x),
    y: roundOrNull(bounds.y),
    width: roundOrNull(bounds.width),
    height: roundOrNull(bounds.height),
  };
  if (rect.x === null || rect.y === null || rect.width === null || rect.height === null) return false;

  return displays.some((display) => {
    const area = workAreaOf(display);
    if (!area) return false;
    const { overlapX, overlapY } = overlapOf(rect, area);
    const needX = Math.min(minVisiblePx, rect.width);
    const needY = Math.min(minVisiblePx, rect.height);
    return overlapX >= needX && overlapY >= needY;
  });
}

/**
 * 在给定屏幕工作区里居中一个窗口。
 *
 * 窗口比屏幕大就缩到屏幕大小：宁可小一点，也不要造出一个挂在屏幕外、
 * 用户抓不到标题栏的窗口（居中算出负偏移正是这种窗口）。
 * 这里**不再**强行抬到 WINDOW_MIN_*：存档来的尺寸在 sanitizeWindowState
 * 里已经保证不小于最小值，默认尺寸（1440x1000）也比最小值大，
 * 再抬一次只会在"屏幕比最小窗口还小"的极端情况下把窗口推出屏幕。
 */
function centeredIn(area, width, height) {
  const fitWidth = Math.max(1, Math.min(width, area.width));
  const fitHeight = Math.max(1, Math.min(height, area.height));
  return {
    x: Math.round(area.x + (area.width - fitWidth) / 2),
    y: Math.round(area.y + (area.height - fitHeight) / 2),
    width: fitWidth,
    height: fitHeight,
  };
}

/**
 * 决定启动时用哪个窗口几何。
 *
 * @param {object} options
 * @param {object | null} options.saved settings.json 里的 windowState（已规范化或 null）
 * @param {Array<object>} options.displays `screen.getAllDisplays()`
 * @param {object} [options.primaryDisplay] `screen.getPrimaryDisplay()`；缺省取 displays[0]
 * @param {{ width: number, height: number }} [options.defaults]
 * @returns {{ bounds: {x:number,y:number,width:number,height:number}, maximized: boolean, source: 'saved'|'saved-centered'|'default', reason: string }}
 */
function resolveStartupWindow({ saved, displays, primaryDisplay, defaults }) {
  const list = Array.isArray(displays) ? displays : [];
  const primary = workAreaOf(primaryDisplay) ?? workAreaOf(list.find((item) => item?.isPrimary)) ?? workAreaOf(list[0]);
  const size = {
    width: defaults?.width ?? WINDOW_DEFAULT_WIDTH,
    height: defaults?.height ?? WINDOW_DEFAULT_HEIGHT,
  };

  // 连一块屏幕都读不到（极端情况：远程会话/驱动异常）：退回默认尺寸、位置交给系统
  if (!primary) {
    return {
      bounds: { x: null, y: null, width: size.width, height: size.height },
      maximized: saved?.maximized === true,
      source: 'default',
      reason: '读不到任何显示器工作区，用默认尺寸并把定位交给系统',
    };
  }

  const fallback = centeredIn(primary, size.width, size.height);

  if (!saved) {
    return { bounds: fallback, maximized: false, source: 'default', reason: '首次启动（没有已保存的窗口状态）' };
  }

  if (saved.x === null || saved.y === null) {
    const bounds = centeredIn(primary, saved.width, saved.height);
    return { bounds, maximized: saved.maximized, source: 'saved-centered', reason: '只记住了尺寸，位置按主屏居中' };
  }

  const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  if (!isOnDisplays(bounds, list.length > 0 ? list : [primary])) {
    return {
      bounds: fallback,
      maximized: saved.maximized,
      source: 'default',
      reason: `已保存的位置 ${JSON.stringify(bounds)} 不在任何屏幕的工作区里（显示器被拔掉？），回退到主屏居中`,
    };
  }

  return { bounds, maximized: saved.maximized === true, source: 'saved', reason: '沿用上次的位置与尺寸' };
}

/**
 * 从窗口对象上抓当前几何。
 *
 * 最大化时要抓 `getNormalBounds()`：那是"还原之后会用的尺寸"。
 * 存 `getBounds()` 会把整块屏幕的尺寸当成普通尺寸记下来，用户下次还原窗口
 * 就得到一个和屏幕一样大的窗口。
 *
 * @param {object} win BrowserWindow（或形状相同的假对象）
 * @returns {{x:number,y:number,width:number,height:number,maximized:boolean} | null} 最小化/已销毁时返回 null（那时的几何没有意义）
 */
function captureWindowState(win) {
  if (!win || typeof win.getBounds !== 'function') return null;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return null;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) return null;

  const maximized = typeof win.isMaximized === 'function' ? win.isMaximized() === true : false;
  const source =
    maximized && typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
  const state = sanitizeWindowState({ ...source, maximized });
  return state;
}

/**
 * 防抖写盘：拖动/缩放过程中每次像素变动都会触发 move/resize，
 * 不能每次都写文件——停下来 delayMs 之后写一次，退出前 flush 一次。
 *
 * 顺带去重：几何没变（比如只是获得焦点触发了一次 resize）就不写。
 *
 * @param {object} options
 * @param {(state: object) => void} options.save 真正的落盘函数
 * @param {number} [options.delayMs]
 * @param {typeof setTimeout} [options.setTimeoutImpl] 测试注入
 * @param {typeof clearTimeout} [options.clearTimeoutImpl] 测试注入
 * @param {(state: object) => string} [options.serialize] 去重用的序列化
 * @returns {{ schedule: (state: object|null) => void, flush: () => boolean, cancel: () => void, stats: () => { writes: number, scheduled: number, skippedIdentical: number, pending: boolean } }}
 */
function createDebouncedSaver(options) {
  const {
    save,
    delayMs = DEFAULT_SAVE_DEBOUNCE_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    serialize = (state) => JSON.stringify(state),
  } = options;

  let timer = null;
  let pending = null;
  let lastWritten = null;
  const stats = { writes: 0, scheduled: 0, skippedIdentical: 0 };

  function flush() {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    const state = pending;
    pending = null;
    if (!state) return false;
    const serialized = serialize(state);
    if (serialized === lastWritten) {
      stats.skippedIdentical += 1;
      return false;
    }
    lastWritten = serialized;
    stats.writes += 1;
    save(state);
    return true;
  }

  function schedule(state) {
    if (!state) return;
    stats.scheduled += 1;
    pending = state;
    if (timer !== null) return; // 已经在等了：只更新待写内容，不重置计时器
    timer = setTimeoutImpl(() => {
      timer = null;
      flush();
    }, delayMs);
  }

  function cancel() {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    pending = null;
  }

  return {
    schedule,
    flush,
    cancel,
    stats: () => ({ ...stats, pending: pending !== null }),
    /** 测试/排障用：把"上次写了什么"重置，让下一次 flush 一定写。 */
    resetLastWritten: () => {
      lastWritten = null;
    },
  };
}

module.exports = {
  MIN_VISIBLE_PX,
  DEFAULT_SAVE_DEBOUNCE_MS,
  sanitizeWindowState,
  workAreaOf,
  isOnDisplays,
  centeredIn,
  resolveStartupWindow,
  captureWindowState,
  createDebouncedSaver,
};
