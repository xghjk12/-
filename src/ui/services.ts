/**
 * 应用级的单例服务：存储、封面缓存、播放状态写入器。
 *
 * 为什么单独放一个模块：这些对象都持有浏览器资源（IndexedDB 连接、对象 URL、定时器），
 * 必须全应用只有一份，而且要在 React 之外创建——组件重渲染不该重建它们。
 * 播放引擎不在这里，因为它的事件回调需要就近写入 store（见 `store.ts` 的 boot）。
 */
import { createCoverCache } from '../platform/coverCache.js';
import type { CoverCache } from '../platform/coverCache.js';
import { memoryStorage } from '../platform/memoryStorage.js';
import { createStateWriter } from '../platform/stateWriter.js';
import type { StateWriter } from '../platform/stateWriter.js';
import { indexedDbStorage, requestPersistentStorage } from '../platform/storage.js';
import type { LibraryStorage } from '../platform/storage.js';

export interface Services {
  storage: LibraryStorage;
  covers: CoverCache;
  writer: StateWriter;
  /** 用的是真 IndexedDB 还是内存降级实现（隐私模式 / 老浏览器）。 */
  persistent: boolean;
}

let services: Services | undefined;
let loading: Promise<Services> | undefined;

async function create(): Promise<Services> {
  let storage: LibraryStorage;
  let persistent = true;
  try {
    storage = await indexedDbStorage();
  } catch {
    // 隐私模式或浏览器禁用 IndexedDB：降级为内存存储，功能可用但刷新即失效
    storage = memoryStorage();
    persistent = false;
  }
  if (persistent) void requestPersistentStorage();

  return {
    storage,
    covers: createCoverCache({ max: 120 }),
    writer: createStateWriter(storage),
    persistent,
  };
}

export async function getServices(): Promise<Services> {
  if (services) return services;
  loading ??= create();
  services = await loading;
  return services;
}

export function getCovers(): CoverCache | undefined {
  return services?.covers;
}

/** 只给测试用：丢掉单例，让下一次 getServices 重新创建。 */
export function resetServices(): void {
  services = undefined;
  loading = undefined;
}
