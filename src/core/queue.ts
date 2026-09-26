/**
 * 播放队列的纯逻辑：播放模式推进、洗牌、上下首与可播放曲目检索。
 *
 * 抽出来单测，是因为这里的状态机有两条靠肉眼很难看出来的分界：
 *  - 「单曲循环」只在**自然播放结束**时重复本首；用户手点「下一首」时仍要前进，
 *    靠 `auto` 区分。两者混用会出现"点了下一首却还在原地"的诡异体验。
 *  - 随机播放是**预先洗牌**得到的下标序列（Fisher-Yates），而不是每次现随机取一首，
 *    否则同一首歌很可能被连续抽中两次。
 *
 * 不引用任何平台 API，因此洗牌用的随机源可以注入，测试才能有确定性。
 */

export type PlayMode = 'sequence' | 'repeat-all' | 'repeat-one' | 'shuffle';

export const MODES: readonly PlayMode[] = ['sequence', 'repeat-all', 'repeat-one', 'shuffle'];

export const MODE_LABEL: Record<PlayMode, string> = {
  sequence: '顺序播放',
  'repeat-all': '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
};

export function isValidMode(value: unknown): value is PlayMode {
  return MODES.includes(value as PlayMode);
}

/** 在四种模式间循环。传入脏数据时回落到第一项，避免界面因此卡死。 */
export function nextMode(mode: PlayMode): PlayMode {
  const index = MODES.indexOf(mode);
  return MODES[(index + 1) % MODES.length]!;
}

/** `0..length-1` 的自然序，用于洗牌缺省序列等场景。 */
function range(length: number): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < length; i += 1) indexes.push(i);
  return indexes;
}

/**
 * 判断洗牌序列是否可用：长度必须与队列一致，且必须是 `0..len-1` 的一个排列。
 *
 * 比 Demo 多检查了「元素本身是否合法」：只比对长度的话，`[9]` 这种越界序列会通过，
 * 之后 `resolveNextIndex` 就可能返回 9 让播放器去取一首不存在的歌。
 */
function isValidOrder(order: readonly number[] | undefined, length: number): order is readonly number[] {
  if (!order || order.length !== length) return false;
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= length || seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

/**
 * Fisher-Yates 洗牌，返回下标序列。
 * 强调"洗牌"而非"每次随机取一首"，避免同一首被连续重复播放。
 * rng 可注入，便于测试确定性；返回的序列长度与入参不为正整数时为空数组。
 *
 * 随机下标会夹到 `[0, i]`：注入的 rng 若返回 1（约定上界是开区间，但外部实现未必守约），
 * 未夹取时 `arr[i + 1]` 会被写成 `undefined`，序列里就会混进空洞。
 */
export function shuffleOrder(length: number, rng?: () => number): number[] {
  const size = Number.isFinite(length) ? Math.floor(length) : 0;
  if (size <= 0) return [];
  const random = typeof rng === 'function' ? rng : Math.random;
  const order = range(size);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const roll = random();
    const normalized = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.9999999999) : 0;
    const j = Math.floor(normalized * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

export interface AdvanceInput {
  mode: PlayMode;
  currentIndex: number;
  queueLength: number;
  /** 随机模式的洗牌序列 */
  order?: readonly number[];
  /** 是否由「自然播放结束」触发 */
  auto?: boolean;
}

/** 归一化队列长度：负数、NaN、小数都收敛成非负整数。 */
function normalizeLength(queueLength: number): number {
  if (!Number.isFinite(queueLength)) return 0;
  const length = Math.floor(queueLength);
  return length > 0 ? length : 0;
}

/**
 * 取随机模式实际使用的洗牌序列：传入的序列不合法时退化为自然序，而不是抛错，
 * 这样界面拿不到 order（例如队列刚被替换）时仍能顺序推进。
 */
function effectiveOrder(order: readonly number[] | undefined, length: number): readonly number[] {
  return isValidOrder(order, length) ? order : range(length);
}

/**
 * 计算下一首在队列中的下标。
 *
 * @param input.mode         播放模式
 * @param input.currentIndex 当前下标
 * @param input.queueLength  队列长度
 * @param input.order        随机模式的洗牌序列
 * @param input.auto         是否由"自然播放结束"触发
 * @returns 下一首下标；-1 表示播放结束
 */
export function resolveNextIndex(input: AdvanceInput): number {
  const length = normalizeLength(input.queueLength);
  const current = input.currentIndex;

  // 空队列没有"下一首"；还没开始播（currentIndex < 0）则从队首起播
  if (length <= 0) return -1;
  if (!Number.isFinite(current) || current < 0) return 0;

  switch (input.mode) {
    case 'repeat-one':
      // 自然结束时重复本首；手动点"下一首"仍按列表循环前进
      return input.auto ? current : (current + 1) % length;

    case 'shuffle': {
      const order = effectiveOrder(input.order, length);
      const position = order.indexOf(current);
      // 当前曲目不在序列里（脏数据）时从序列开头接上
      const nextPosition = (position === -1 ? 0 : position) + 1;
      return nextPosition >= length ? order[0]! : order[nextPosition]!;
    }

    case 'repeat-all':
      return (current + 1) % length;

    default: {
      // sequence：顺序播放到末尾即停止，不静默绕回
      const next = current + 1;
      return next >= length ? -1 : next;
    }
  }
}

/**
 * 计算上一首在队列中的下标。
 * 顺序模式下停在第一首；其余模式从队首回到队尾（符合常见播放器直觉）。
 */
export function resolvePrevIndex(input: Omit<AdvanceInput, 'auto'>): number {
  const length = normalizeLength(input.queueLength);
  const current = input.currentIndex;

  if (length <= 0) return -1;
  if (!Number.isFinite(current) || current < 0) return 0;

  if (input.mode === 'shuffle') {
    const order = effectiveOrder(input.order, length);
    const position = order.indexOf(current);
    if (position > 0) return order[position - 1]!;
    // 队首（或序列里没有本首）时回到序列末尾
    return order[length - 1]!;
  }

  if (current === 0) {
    return input.mode === 'sequence' ? 0 : length - 1;
  }
  return current - 1;
}

/**
 * 从 `from` 起向后找第一个可播放的下标（含 `from` 本身）；找不到返回 -1。
 *
 * 只走一圈：`from` 在队列外时从队首重新开始，全队列都不可播放时不会死循环。
 */
export function findPlayableIndex(
  queueLength: number,
  from: number,
  canPlay: (index: number) => boolean,
): number {
  const length = normalizeLength(queueLength);
  if (length <= 0) return -1;

  const start = Number.isFinite(from) ? Math.floor(from) : 0;
  for (let step = 0; step < length; step += 1) {
    const index = (((start + step) % length) + length) % length;
    if (canPlay(index)) return index;
  }
  return -1;
}

export interface QueueRemoval<T> {
  queue: T[];
  currentIndex: number;
  /** 被移除的正是当前曲目：调用方应当停止播放。 */
  removedCurrent: boolean;
}

/**
 * 从队列里移除一项并修正当前下标。
 *
 * 这是队列里最容易写错的一处，三种情况必须分开处理：
 *  - 移除的**就是当前曲目** → 下标置 -1（停止播放等用户重新点播），而不是悄悄往下播
 *  - 移除的**在当前曲目之前** → 当前下标必须减 1，否则会跳到别的曲目上
 *  - 移除的**在当前曲目之后** → 下标不变
 *
 * 抽成 core 的纯函数是为了能穷举测：`ui/store.ts` 里原来这段逻辑没有任何单测。
 */
export function removeQueueItem<T>(
  queue: readonly T[],
  currentIndex: number,
  removeIndex: number,
): QueueRemoval<T> {
  if (removeIndex < 0 || removeIndex >= queue.length) {
    return { queue: [...queue], currentIndex, removedCurrent: false };
  }

  const next = queue.filter((_, index) => index !== removeIndex);

  if (currentIndex < 0) {
    return { queue: next, currentIndex, removedCurrent: false };
  }
  if (removeIndex === currentIndex) {
    return { queue: next, currentIndex: -1, removedCurrent: true };
  }
  return {
    queue: next,
    currentIndex: removeIndex < currentIndex ? currentIndex - 1 : currentIndex,
    removedCurrent: false,
  };
}
