/**
 * 封面 LRU 的行为锁定（技术方案 5.4）。
 *
 * 核心断言只有一句：`createObjectURL` 出去的每一个 URL，最终都必须被 `revokeObjectURL` 回收，
 * 而且正在被显示引用的封面不能被回收（否则列表回滚时会看到裂图）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createCoverCache } from './coverCache.js';

function setup(max = 2) {
  const created: string[] = [];
  const revoked: string[] = [];
  const cache = createCoverCache({
    max,
    createObjectURL: () => {
      const url = `blob:cover-${created.length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
  });
  return { cache, created, revoked };
}

const blob = (): Promise<Blob> => Promise.resolve(new Blob(['x']));

describe('createCoverCache：读取与复用', () => {
  it('同一首歌第二次取用不再读封面', async () => {
    const { cache, created } = setup();
    const load = vi.fn(blob);

    const first = await cache.acquire('k1', load);
    const second = await cache.acquire('k1', load);

    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('并发取同一首只加载一次', async () => {
    const { cache } = setup();
    const load = vi.fn(blob);

    const [a, b] = await Promise.all([
      cache.acquire('k1', load),
      cache.acquire('k1', load),
    ]);

    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('没有封面时返回 undefined，不产生对象 URL', async () => {
    const { cache, created } = setup();

    await expect(cache.acquire('k1', async () => undefined)).resolves.toBeUndefined();
    expect(created).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it('load 抛异常时不留下半个缓存', async () => {
    const { cache } = setup();
    await expect(
      cache.acquire('k1', async () => {
        throw new Error('读封面失败');
      }),
    ).rejects.toThrow('读封面失败');
    expect(cache.size).toBe(0);
  });
});

describe('createCoverCache：LRU 回收', () => {
  it('超出上限时回收最久没被引用的封面', async () => {
    const { cache, revoked } = setup(2);

    const u1 = await cache.acquire('k1', blob);
    await cache.acquire('k2', blob);
    cache.release('k1');
    cache.release('k2');

    // 第三个进来，超上限：k1 是最久没用的，应当被回收
    await cache.acquire('k3', blob);

    expect(revoked).toEqual([u1]);
    expect(cache.size).toBe(2);
  });

  it('还被引用的封面绝不回收（宁可不缓存，也不制造裂图）', async () => {
    const { cache, revoked } = setup(1);

    const u1 = await cache.acquire('k1', blob);
    // 一直持有 k1 的引用，随后连续加载多个新封面
    await cache.acquire('k2', blob);
    await cache.acquire('k3', blob);

    expect(revoked).not.toContain(u1);
  });

  it('release 之后才进入可回收队列', async () => {
    const { cache, revoked } = setup(1);

    const u1 = await cache.acquire('k1', blob);
    await cache.acquire('k2', blob);
    expect(revoked).toEqual([]);

    cache.release('k1');
    // 下一次 acquire 时才触发回收
    await cache.acquire('k3', blob);
    expect(revoked).toEqual([u1]);
  });

  it('重复 release 不会把引用数减成负数', async () => {
    const { cache, revoked } = setup(1);
    const u1 = await cache.acquire('k1', blob);

    cache.release('k1');
    cache.release('k1');
    cache.release('k1');

    await cache.acquire('k2', blob);
    expect(revoked).toEqual([u1]);
  });
});

describe('createCoverCache：清理', () => {
  it('clear 回收全部对象 URL', async () => {
    const { cache, created, revoked } = setup(10);

    await cache.acquire('k1', blob);
    await cache.acquire('k2', blob);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(revoked).toEqual(created);
  });

  it('clear 之后同一首歌会重新加载', async () => {
    const { cache, created } = setup(10);

    await cache.acquire('k1', blob);
    cache.clear();
    await cache.acquire('k1', blob);

    expect(created).toHaveLength(2);
  });
});
