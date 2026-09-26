/**
 * 封面的对象 URL 缓存（技术方案 5.4）。
 *
 * 3000 首的库不能把封面都留在内存里，所以：
 *  - 列表按需读取封面，`URL.createObjectURL` 之后**必须在滚出视口或组件卸载时释放**
 *  - 用一个小 LRU（默认 100 张）兜住来回滚动
 *  - 引用计数不为 0 的条目不会被回收，避免正在显示的行突然变成裂图
 *
 * 实测两首真实歌曲都没有内嵌封面，所以"没有封面"是常态：这里返回 undefined 时
 * 界面必须给出稳定的占位样式。
 */
export interface CoverCacheOptions {
  /** 最多保留多少张封面，默认 100。 */
  max?: number;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export interface CoverCache {
  /**
   * 取一个可用的对象 URL 并占用一次引用。
   * 没有封面（load 返回 undefined）或取 URL 失败时返回 undefined。
   */
  acquire(cacheKey: string, load: () => Promise<Blob | undefined>): Promise<string | undefined>;
  /** 释放一次引用；引用归零后才会进入可回收队列。 */
  release(cacheKey: string): void;
  /** 强制清空并 revoke 全部对象 URL。 */
  clear(): void;
  readonly size: number;
}

interface Entry {
  url: string;
  refs: number;
}

export function createCoverCache(options: CoverCacheOptions = {}): CoverCache {
  const max = Math.max(1, options.max ?? 100);
  const createObjectURL =
    options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));

  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<string | undefined>>();
  /** 引用归零的键，越靠前越久没被用过。 */
  const idle: string[] = [];

  function markIdle(cacheKey: string): void {
    if (!idle.includes(cacheKey)) idle.push(cacheKey);
  }

  function dropIdle(cacheKey: string): void {
    const index = idle.indexOf(cacheKey);
    if (index >= 0) idle.splice(index, 1);
  }

  function evict(): void {
    while (entries.size > max) {
      const cacheKey = idle.shift();
      if (cacheKey === undefined) return; // 全都在使用中，宁可不回收也不制造裂图
      const entry = entries.get(cacheKey);
      if (!entry || entry.refs > 0) continue;
      entries.delete(cacheKey);
      revokeObjectURL(entry.url);
    }
  }

  return {
    get size() {
      return entries.size;
    },

    async acquire(cacheKey, load) {
      const existing = entries.get(cacheKey);
      if (existing) {
        existing.refs += 1;
        dropIdle(cacheKey);
        return existing.url;
      }

      let promise = inflight.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const blob = await load();
          if (!blob) return undefined;
          return createObjectURL(blob);
        })();
        inflight.set(cacheKey, promise);
      }

      try {
        const url = await promise;
        if (!url) return undefined;
        const entry = entries.get(cacheKey);
        if (entry) {
          entry.refs += 1;
          dropIdle(cacheKey);
          return entry.url;
        }
        entries.set(cacheKey, { url, refs: 1 });
        evict();
        return url;
      } finally {
        if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
      }
    },

    release(cacheKey) {
      const entry = entries.get(cacheKey);
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0) markIdle(cacheKey);
    },

    clear() {
      for (const entry of entries.values()) revokeObjectURL(entry.url);
      entries.clear();
      idle.length = 0;
      inflight.clear();
    },
  };
}
