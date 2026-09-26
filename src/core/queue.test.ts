import { describe, expect, it } from 'vitest';
import type { AdvanceInput, PlayMode } from './queue.js';
import {
  findPlayableIndex,
  isValidMode,
  MODE_LABEL,
  MODES,
  nextMode,
  removeQueueItem,
  resolveNextIndex,
  resolvePrevIndex,
  shuffleOrder,
} from './queue.js';

/** 供 random 模式使用的固定洗牌序列：队列下标 2 -> 0 -> 1。 */
const ORDER = [2, 0, 1];

/** 造推进参数，省略字段用最普通的默认值，让每个用例只表达它真正在测的东西。 */
function advance(input: Partial<AdvanceInput> & { mode: PlayMode }): number {
  return resolveNextIndex({
    currentIndex: 0,
    queueLength: 3,
    ...input,
  });
}

describe('模式常量', () => {
  it('MODES 按界面循环顺序列出四种模式', () => {
    expect(MODES).toEqual(['sequence', 'repeat-all', 'repeat-one', 'shuffle']);
  });

  it('MODE_LABEL 覆盖每一种模式，且没有多余键', () => {
    for (const mode of MODES) {
      expect(MODE_LABEL[mode], mode).toBeTruthy();
    }
    expect(MODE_LABEL.sequence).toBe('顺序播放');
    expect(MODE_LABEL['repeat-all']).toBe('列表循环');
    expect(MODE_LABEL['repeat-one']).toBe('单曲循环');
    expect(MODE_LABEL.shuffle).toBe('随机播放');
    expect(Object.keys(MODE_LABEL).sort()).toEqual([...MODES].sort());
  });

  it('isValidMode 只认这四种模式', () => {
    for (const mode of MODES) {
      expect(isValidMode(mode), mode).toBe(true);
    }
    for (const value of ['SEQUENCE', 'repeat', '', null, undefined, 0, {}, ['sequence']]) {
      expect(isValidMode(value), String(value)).toBe(false);
    }
  });

  it('nextMode 在四种模式间循环', () => {
    expect(nextMode('sequence')).toBe('repeat-all');
    expect(nextMode('repeat-all')).toBe('repeat-one');
    expect(nextMode('repeat-one')).toBe('shuffle');
    expect(nextMode('shuffle')).toBe('sequence');
    // 未知模式回落到第一项，避免界面因脏数据卡死
    expect(nextMode('nonsense' as PlayMode)).toBe('sequence');
  });
});

describe('shuffleOrder', () => {
  it('返回完整排列且不产生重复', () => {
    const order = shuffleOrder(24);
    expect(order).toHaveLength(24);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(new Set(order).size).toBe(24);
  });

  it('固定随机源下结果确定，且与自然序不同（确实洗过）', () => {
    const makeRng = () => {
      let seed = 42;
      return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
    };
    const first = shuffleOrder(10, makeRng());
    expect(first).toEqual(shuffleOrder(10, makeRng()));
    expect(first).toHaveLength(10);
    expect(new Set(first).size).toBe(10);
    expect(first).not.toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it('随机源返回边界值 1 时不会越过数组边界', () => {
    const order = shuffleOrder(5, () => 1);
    expect(order).toHaveLength(5);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(order.every((index) => Number.isInteger(index))).toBe(true);
  });

  it('处理空、单元素与非法长度', () => {
    expect(shuffleOrder(0)).toEqual([]);
    expect(shuffleOrder(1)).toEqual([0]);
    expect(shuffleOrder(-3)).toEqual([]);
    expect(shuffleOrder(NaN)).toEqual([]);
    expect(shuffleOrder(2.7)).toHaveLength(2);
  });
});

describe('resolveNextIndex', () => {
  it('空队列与未开始状态', () => {
    expect(advance({ mode: 'sequence', currentIndex: -1, queueLength: 0 })).toBe(-1);
    expect(advance({ mode: 'sequence', currentIndex: -1, queueLength: 3 })).toBe(0);
    expect(advance({ mode: 'shuffle', currentIndex: -1, queueLength: 3 })).toBe(0);
  });

  it('队列长度为 0 / 负数 / 非数值时一律返回 -1', () => {
    for (const queueLength of [0, -1, NaN, Infinity, -0]) {
      expect(advance({ mode: 'repeat-all', queueLength }), String(queueLength)).toBe(-1);
    }
  });

  it('顺序播放到末尾即结束，不静默绕回', () => {
    expect(advance({ mode: 'sequence', currentIndex: 0 })).toBe(1);
    expect(advance({ mode: 'sequence', currentIndex: 2 })).toBe(-1);
    expect(advance({ mode: 'sequence', currentIndex: 2, auto: true })).toBe(-1);
  });

  it('列表循环回到队首', () => {
    expect(advance({ mode: 'repeat-all', currentIndex: 2 })).toBe(0);
    expect(advance({ mode: 'repeat-all', currentIndex: 2, auto: true })).toBe(0);
  });

  it('单曲循环区分自动与手动', () => {
    expect(advance({ mode: 'repeat-one', currentIndex: 1, auto: true })).toBe(1);
    expect(advance({ mode: 'repeat-one', currentIndex: 1 })).toBe(2);
    expect(advance({ mode: 'repeat-one', currentIndex: 2 })).toBe(0);
  });

  it('单元素队列：单曲循环自动重播，手动下一首仍是本首', () => {
    expect(advance({ mode: 'repeat-one', currentIndex: 0, queueLength: 1, auto: true })).toBe(0);
    expect(advance({ mode: 'repeat-one', currentIndex: 0, queueLength: 1 })).toBe(0);
    expect(advance({ mode: 'sequence', currentIndex: 0, queueLength: 1 })).toBe(-1);
    expect(advance({ mode: 'repeat-all', currentIndex: 0, queueLength: 1 })).toBe(0);
  });

  it('随机模式按洗牌序列推进并循环', () => {
    expect(advance({ mode: 'shuffle', currentIndex: 2, order: ORDER })).toBe(0);
    expect(advance({ mode: 'shuffle', currentIndex: 0, order: ORDER })).toBe(1);
    // 序列走完应回到序列开头
    expect(advance({ mode: 'shuffle', currentIndex: 1, order: ORDER })).toBe(2);
  });

  it('随机模式缺序列或序列非法时退化为自然序推进', () => {
    expect(advance({ mode: 'shuffle', currentIndex: 0 })).toBe(1);
    // 长度对不上
    expect(advance({ mode: 'shuffle', currentIndex: 0, order: [9] })).toBe(1);
    // 长度对但含越界下标：不能把播放器指向不存在的曲目
    expect(advance({ mode: 'shuffle', currentIndex: 0, order: [0, 1, 7] })).toBe(1);
    // 含重复下标，不是排列
    expect(advance({ mode: 'shuffle', currentIndex: 0, order: [0, 0, 1] })).toBe(1);
    // 含负数
    expect(advance({ mode: 'shuffle', currentIndex: 0, order: [-1, 0, 1] })).toBe(1);
  });

  it('随机模式下当前曲目不在洗牌序列里时从序列开头接上', () => {
    // [0, 1, 2] 是合法排列，但下标 3 不在其中：从序列开头接上
    expect(resolveNextIndex({
      mode: 'shuffle',
      currentIndex: 3,
      queueLength: 3,
      order: [0, 1, 2],
    })).toBe(1);
    // 越界下标同样处理
    expect(advance({ mode: 'shuffle', currentIndex: 9, queueLength: 3, order: [0, 1, 2] })).toBe(1);
  });

  it('currentIndex 越界时按各模式语义收敛', () => {
    expect(advance({ mode: 'sequence', currentIndex: 9, queueLength: 3 })).toBe(-1);
    expect(advance({ mode: 'repeat-all', currentIndex: 9, queueLength: 3 })).toBe(1);
    // 1 不在序列 [2, 0, 1] 里：从序列开头接上
    expect(advance({ mode: 'shuffle', currentIndex: 9, queueLength: 3, order: ORDER })).toBe(0);
    // repeat-one 手动前进也走列表循环，不越界
    expect(advance({ mode: 'repeat-one', currentIndex: 9, queueLength: 3 })).toBe(1);
  });

  it('全程顺序播放不会重复或遗漏任何曲目', () => {
    const length = 6;
    const visited: number[] = [];
    let index = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      visited.push(index);
      const next = resolveNextIndex({
        mode: 'sequence',
        currentIndex: index,
        queueLength: length,
        auto: true,
      });
      if (next === -1) break;
      index = next;
    }
    expect(visited).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('全程随机播放恰好覆盖队列一次', () => {
    const length = 5;
    const order = shuffleOrder(length, () => 0.5);
    const visited: number[] = [];
    let index = order[0]!;
    for (let step = 0; step <= length; step += 1) {
      visited.push(index);
      index = resolveNextIndex({ mode: 'shuffle', currentIndex: index, queueLength: length, order });
    }
    // 走满 len + 1 步回到起点，中途每个下标都恰好经过一次
    expect(visited).toHaveLength(length + 1);
    expect(visited[length]).toBe(visited[0]);
    expect(visited.slice(0, length).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('resolvePrevIndex', () => {
  it('顺序模式停在队首，其余模式回到队尾', () => {
    expect(resolvePrevIndex({ mode: 'sequence', currentIndex: 0, queueLength: 3 })).toBe(0);
    expect(resolvePrevIndex({ mode: 'repeat-all', currentIndex: 0, queueLength: 3 })).toBe(2);
    expect(resolvePrevIndex({ mode: 'repeat-one', currentIndex: 0, queueLength: 3 })).toBe(2);
    expect(resolvePrevIndex({ mode: 'sequence', currentIndex: 2, queueLength: 3 })).toBe(1);
    expect(resolvePrevIndex({ mode: 'sequence', currentIndex: -1, queueLength: 3 })).toBe(0);
  });

  it('空队列返回 -1，未开始状态返回 0', () => {
    expect(resolvePrevIndex({ mode: 'sequence', currentIndex: 0, queueLength: 0 })).toBe(-1);
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: -1, queueLength: 4 })).toBe(0);
  });

  it('单元素队列总是回到本首', () => {
    for (const mode of MODES) {
      expect(resolvePrevIndex({ mode, currentIndex: 0, queueLength: 1 }), mode).toBe(0);
    }
  });

  it('随机模式沿洗牌序列回退', () => {
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3, order: ORDER })).toBe(2);
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: 1, queueLength: 3, order: ORDER })).toBe(0);
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: 2, queueLength: 3, order: ORDER })).toBe(1);
  });

  it('随机模式序列非法时退化为自然序回退', () => {
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3, order: [1] })).toBe(2);
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: 0, queueLength: 3, order: [0, 0, 2] })).toBe(2);
    expect(resolvePrevIndex({ mode: 'shuffle', currentIndex: 2, queueLength: 3, order: [0, 1, 9] })).toBe(1);
  });
});

describe('findPlayableIndex', () => {
  const playable = (indexes: number[]) => (index: number) => indexes.includes(index);

  it('从 from 起向后找第一个可播放的下标（含 from 本身）', () => {
    expect(findPlayableIndex(5, 2, playable([2, 3]))).toBe(2);
    expect(findPlayableIndex(5, 0, playable([3]))).toBe(3);
  });

  it('走到队尾后绕回队首继续找', () => {
    expect(findPlayableIndex(5, 3, playable([1]))).toBe(1);
  });

  it('全队列不可播放时返回 -1', () => {
    expect(findPlayableIndex(5, 0, () => false)).toBe(-1);
    expect(findPlayableIndex(5, 4, () => false)).toBe(-1);
  });

  it('空队列或非法长度返回 -1，且不调用判定函数', () => {
    let calls = 0;
    const canPlay = () => {
      calls += 1;
      return true;
    };
    for (const queueLength of [0, -2, NaN]) {
      expect(findPlayableIndex(queueLength, 0, canPlay), String(queueLength)).toBe(-1);
    }
    expect(calls).toBe(0);
  });

  it('from 越界或为负时折回队列内，只扫一圈', () => {
    let calls = 0;
    const canPlay = () => {
      calls += 1;
      return true;
    };
    // 99 折回 99 % 4 = 3
    expect(findPlayableIndex(4, 99, canPlay)).toBe(3);
    expect(calls).toBe(1);
    expect(findPlayableIndex(4, -1, playable([2]))).toBe(2);
    expect(findPlayableIndex(4, 8, playable([0]))).toBe(0);
  });
});

describe('removeQueueItem：移除队列项时的下标修正', () => {
  const QUEUE = ['a', 'b', 'c', 'd'];

  it('移除的是当前曲目 → 下标置 -1，并告诉调用方要停止播放', () => {
    const result = removeQueueItem(QUEUE, 2, 2);

    expect(result.queue).toEqual(['a', 'b', 'd']);
    expect(result.currentIndex).toBe(-1);
    expect(result.removedCurrent).toBe(true);
  });

  it('移除当前曲目之前的项 → 下标减 1（否则会跳到别的曲目上）', () => {
    const result = removeQueueItem(QUEUE, 2, 0);

    expect(result.queue).toEqual(['b', 'c', 'd']);
    expect(result.currentIndex).toBe(1);
    expect(result.removedCurrent).toBe(false);
    // 修正后的下标仍然指向原来那首歌
    expect(result.queue[result.currentIndex]).toBe('c');
  });

  it('移除当前曲目之后的项 → 下标不变', () => {
    const result = removeQueueItem(QUEUE, 1, 3);

    expect(result.queue).toEqual(['a', 'b', 'c']);
    expect(result.currentIndex).toBe(1);
    expect(result.queue[result.currentIndex]).toBe('b');
  });

  it('没有当前曲目（-1）时只删项，不改下标', () => {
    const result = removeQueueItem(QUEUE, -1, 1);

    expect(result.queue).toEqual(['a', 'c', 'd']);
    expect(result.currentIndex).toBe(-1);
    expect(result.removedCurrent).toBe(false);
  });

  it('下标越界时原样返回，不改动原数组', () => {
    for (const removeIndex of [-1, 4, 99]) {
      const result = removeQueueItem(QUEUE, 1, removeIndex);
      expect(result.queue, String(removeIndex)).toEqual(QUEUE);
      expect(result.currentIndex).toBe(1);
    }
    // 入参不能被就地修改
    const original = [...QUEUE];
    removeQueueItem(QUEUE, 0, 0);
    expect(QUEUE).toEqual(original);
  });

  it('删到只剩一项、以及删空都能正确收尾', () => {
    const single = removeQueueItem(['a'], 0, 0);
    expect(single.queue).toEqual([]);
    expect(single.currentIndex).toBe(-1);

    const empty = removeQueueItem([], 0, 0);
    expect(empty.queue).toEqual([]);
    expect(empty.removedCurrent).toBe(false);
  });
});
