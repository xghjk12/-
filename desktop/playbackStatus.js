'use strict';

const { SHELL_COMMAND_TYPES } = require('./constants.js');

/**
 * 播放状态（渲染进程上报 → 主进程消费）的规范化与查询。
 *
 * 为什么要单独一个纯模块：托盘菜单文案必须**跟着真实播放状态走**（播放中显示「暂停」，
 * 暂停时显示「播放」），而这个状态只有渲染进程知道（音频元素与 store 都在那边）。
 * 主进程不许猜——猜出来的文案会在"自动切歌""播完停下"这些时刻骗用户。
 * 上报载荷是跨进程来的、字段可能缺可能脏，所以进主进程第一件事就是规范化，
 * 规范化规则本身要能被单测钉住（desktop/playbackStatus.test.cjs）。
 *
 * 纯 Node 模块（不 require electron），单测直接跑。
 */

/** 还没收到任何上报时的状态：三个播放菜单项一律禁用（无从判断有没有曲目可播）。 */
const PLAYBACK_STATUS_UNKNOWN = Object.freeze({
  reported: false,
  playing: false,
  hasTrack: false,
  currentIndex: null,
  queueLength: null,
  reportedAt: null,
});

function toCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 规范化上报载荷。
 *
 * @param {unknown} raw 渲染进程发来的东西（可能是 undefined / 数组 / 缺字段）
 * @param {() => string} [now] 时间戳来源（测试可注入）
 * @returns {{ reported: boolean, playing: boolean, hasTrack: boolean, currentIndex: number | null, queueLength: number | null, reportedAt: string | null }}
 */
function normalizePlaybackStatus(raw, now = () => new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...PLAYBACK_STATUS_UNKNOWN };
  }

  const currentIndex = toCount(raw.currentIndex);
  const queueLength = toCount(raw.queueLength);
  // hasTrack 以渲染进程给的布尔为准；没给（或给了脏值）就从队列事实推出来——
  // 这两者都是"渲染进程报上来的事实"，不是主进程在猜播放状态
  const hasTrack =
    typeof raw.hasTrack === 'boolean'
      ? raw.hasTrack
      : Boolean(queueLength !== null && queueLength > 0 && currentIndex !== null && currentIndex >= 0);

  return {
    reported: true,
    playing: raw.playing === true,
    hasTrack,
    currentIndex,
    queueLength,
    reportedAt: typeof now === 'function' ? now() : new Date().toISOString(),
  };
}

/**
 * 两份状态在"菜单关心的维度"上是否有变化。
 *
 * 用途：渲染进程每次 store 变化都会评估一次，但只有播放相关切片变了才值得
 * 跨进程发一次 IPC + 重建一次托盘菜单。无关变化（音量、抽屉、检索词…）
 * 一律不发——否则拖一下音量条就会重建几十次菜单。
 *
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 * @returns {boolean}
 */
function sameMenuRelevantStatus(a, b) {
  if (!a || !b) return a === b;
  return (
    a.playing === b.playing &&
    a.hasTrack === b.hasTrack &&
    a.currentIndex === b.currentIndex &&
    a.queueLength === b.queueLength
  );
}

/** 是不是合法的壳层命令类型（白名单见 constants.js）。 */
function isShellCommandType(value) {
  return typeof value === 'string' && SHELL_COMMAND_TYPES.includes(value);
}

/** 菜单文案：播放中 →「暂停」，否则 →「播放」。 */
function playPauseLabel(status) {
  return status && status.playing === true ? '暂停' : '播放';
}

module.exports = {
  PLAYBACK_STATUS_UNKNOWN,
  normalizePlaybackStatus,
  sameMenuRelevantStatus,
  isShellCommandType,
  playPauseLabel,
};
