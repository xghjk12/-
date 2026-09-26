/**
 * IndexedDB 实现本身的测试（用 `fake-indexeddb` 顶上浏览器的实现）。
 *
 * 为什么需要它：在 `/` 里的这套逻辑，之前只有 `memoryStorage` 替身被测过，
 * 真实现只被界面冒烟间接覆盖了"全新创建 + 写入 + 读回"这一条最短路径。
 * 而这里有一条**风险最高、又从未执行过**的路径：
 *
 * > 已经用旧版本扫过曲库的用户，浏览器里存着 v1 的库。新版本第一次打开时，
 * > `openDB` 会带着 oldVersion=1 触发 upgrade。这一步要是出错，`getServices()`
 * > 会静默降级成内存存储——用户看到的就是"曲库空了，得重扫"。
 *
 * 所以这里显式地建一个 v1 老库、灌入老数据，再走产品代码打开，断言老数据还在、
 * 新仓库可用。`fake-indexeddb/auto` 会把 `indexedDB` 挂到 globalThis 上。
 *
 * 隔离方式：每个用例换成**全新的 IDBFactory**，而不是去删库。
 * 产品实现会长期持有连接（本来就是设计如此），删库会被它挡住；换工厂则天然干净。
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Track } from '../core/track.js';
import { DB_NAME, DB_VERSION, indexedDbStorage } from './storage.js';
import type { PlaybackState } from './storage.js';

/** 造一条老版本写进去的曲目记录（没有 searchKey）。 */
function legacyTrack(path: string): Track {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1024,
    lastModified: 1,
    cacheKey: `${path}\u00001024\u00001`,
    title: '青花瓷',
    titleFromFileName: false,
    durationSec: 200,
    extension: 'flac',
    verdict: 'decodable',
    hasCover: false,
    addedAt: 1000,
  };
}

const LEGACY_STATE: PlaybackState = {
  volume: 0.5,
  muted: false,
  mode: 'repeat-all',
  trackPath: '专辑/a.flac',
  positionSec: 42,
  recentPaths: ['专辑/a.flac'],
  updatedAt: 1000,
};

/** 按 v1 的 schema 建一个老库并灌入数据，模拟"用户用旧版本扫过曲库"。 */
async function seedVersion1(): Promise<void> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore('files', { keyPath: 'path' });
      database.createObjectStore('tracks');
      database.createObjectStore('covers');
      database.createObjectStore('state');
      database.createObjectStore('handles');
    },
  });

  const track = legacyTrack('专辑/a.flac');
  await db.put('tracks', track, track.cacheKey);
  // files 仓库声明了 keyPath: 'path'，所以不能再显式传键（传了会抛 DataError）
  await db.put('files', {
    path: track.path,
    size: track.size,
    lastModified: track.lastModified,
    cacheKey: track.cacheKey,
  });
  await db.put('state', LEGACY_STATE, 'playback');
  await db.put('handles', { fake: 'handle' }, 'music-root');
  db.close();
}

beforeEach(() => {
  // 每个用例一个全新的数据库世界：不必删库，也就不会被产品代码持有的连接挡住
  globalThis.indexedDB = new IDBFactory();
});

describe('indexedDbStorage：全新创建', () => {
  it('建出 v2 并包含全部仓库', async () => {
    const storage = await indexedDbStorage();

    const probe = await openDB(DB_NAME, DB_VERSION);
    expect(probe.version).toBe(2);
    for (const name of ['files', 'tracks', 'covers', 'lyrics', 'state', 'settings', 'handles']) {
      expect(probe.objectStoreNames.contains(name), name).toBe(true);
    }
    probe.close();

    // 各仓库都能用
    await expect(storage.listTracks()).resolves.toEqual([]);
    await expect(storage.listLyrics()).resolves.toEqual([]);
    await expect(storage.readSettings()).resolves.toBeUndefined();
  });

  it('歌词与设置能写能读', async () => {
    const storage = await indexedDbStorage();

    await storage.putLyrics([
      {
        path: '专辑/a.flac',
        text: '[00:01.00]青花瓷',
        source: 'sidecar',
        lyricPath: '专辑/a.lrc',
        lyricModifiedAt: 123,
        userOffsetSec: 0.5,
        updatedAt: 999,
      },
    ]);
    await storage.writeSettings({ lyricSearchTemplate: 'https://example.com/?q={keyword}' });

    await expect(storage.getLyrics('专辑/a.flac')).resolves.toMatchObject({
      text: '[00:01.00]青花瓷',
      source: 'sidecar',
      userOffsetSec: 0.5,
    });
    await expect(storage.listLyrics()).resolves.toHaveLength(1);
    await expect(storage.readSettings()).resolves.toEqual({
      lyricSearchTemplate: 'https://example.com/?q={keyword}',
    });
  });
});

describe('indexedDbStorage：v1 老库升级到 v2', () => {
  it('老数据全部保留', async () => {
    await seedVersion1();

    const storage = await indexedDbStorage();

    expect(await storage.listTracks()).toHaveLength(1);
    expect(await storage.getTrack('专辑/a.flac\u00001024\u00001')).toMatchObject({
      title: '青花瓷',
    });
    expect(await storage.listFiles()).toHaveLength(1);
    await expect(storage.readState()).resolves.toMatchObject({
      volume: 0.5,
      mode: 'repeat-all',
      positionSec: 42,
    });
    await expect(storage.loadHandle('music-root')).resolves.toEqual({ fake: 'handle' });
  });

  it('升级后新仓库可用（歌词、设置）', async () => {
    await seedVersion1();
    const storage = await indexedDbStorage();

    await storage.putLyrics([
      {
        path: '专辑/a.flac',
        text: '粘贴的歌词',
        source: 'paste',
        userOffsetSec: 0,
        updatedAt: 1,
      },
    ]);
    await storage.writeSettings({ lyricSearchTemplate: 'https://example.com/?q={title}' });

    await expect(storage.getLyrics('专辑/a.flac')).resolves.toMatchObject({ text: '粘贴的歌词' });
    await expect(storage.readSettings()).resolves.toMatchObject({
      lyricSearchTemplate: 'https://example.com/?q={title}',
    });

    // 老数据也还在（升级不是重建）
    await expect(storage.listTracks()).resolves.toHaveLength(1);
  });

  it('升级后清空曲库会连新仓库一起清掉', async () => {
    await seedVersion1();
    const storage = await indexedDbStorage();
    await storage.putLyrics([
      { path: '专辑/a.flac', text: 'x', source: 'paste', userOffsetSec: 0, updatedAt: 1 },
    ]);

    await storage.clearAll();

    await expect(storage.listTracks()).resolves.toEqual([]);
    await expect(storage.listFiles()).resolves.toEqual([]);
    await expect(storage.listLyrics()).resolves.toEqual([]);
    await expect(storage.readState()).resolves.toBeUndefined();
    await expect(storage.readSettings()).resolves.toBeUndefined();
  });

  it('重复打开同一个库不会把版本再往上推（升级回调只跑一次）', async () => {
    await seedVersion1();

    const first = await indexedDbStorage();
    await first.putLyrics([
      { path: 'a.flac', text: 'x', source: 'paste', userOffsetSec: 0, updatedAt: 1 },
    ]);

    // 关掉再开一次：如果 upgrade 里的 createObjectStore 没有做存在性判断，这里会抛错
    const probe = await openDB(DB_NAME, DB_VERSION);
    expect(probe.version).toBe(2);
    probe.close();

    const second = await indexedDbStorage();
    await expect(second.getLyrics('a.flac')).resolves.toMatchObject({ text: 'x' });
  });
});
