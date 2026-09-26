/**
 * IndexedDB 存储层（技术方案 5.2）。
 *
 * 三类数据各有自己的对象仓库，刻意分开：
 *  - `tracks` 存元数据，`covers` 单独存封面字节 —— 3000 首的库不能把封面都读进内存
 *  - `files` 存目录清单（路径 + 大小 + 修改时间），增量扫描靠它对比
 *  - `state` / `handles` 存播放状态与目录句柄
 *
 * 曲目身份用 `path`，缓存键用 `cacheKey`（路径 + 大小 + 修改时间）：拿缓存键当身份的话，
 * 文件一被编辑，「上次播到哪儿」就丢了（技术方案 5.1）。
 *
 * 为什么要抽成接口：扫描逻辑（`scanner.ts`）只依赖这个接口，于是可以在 Node 里用
 * `memoryStorage()` 完整测出「缓存命中 / 增量更新 / 孤儿清理」，不需要真浏览器。
 */
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Track } from '../core/track.js';
import type { PlayMode } from '../core/queue.js';

export interface StoredFile {
  /** 相对曲库根目录的 posix 路径，也是这个仓库的主键。 */
  path: string;
  size: number;
  lastModified: number;
  cacheKey: string;
}

export interface CoverRecord {
  mimeType: string;
  data: Blob;
}

export interface PlaybackState {
  volume: number;
  muted: boolean;
  mode: PlayMode;
  /** 当前曲目的身份（path），不是缓存键。 */
  trackPath?: string;
  positionSec: number;
  /** 最近播放过的曲目身份，最新在前（上限见 store 里的 RECENT_LIMIT）。 */
  recentPaths?: string[];
  updatedAt: number;
}

/** 曲库存储契约。扫描、播放状态持久化、句柄持久化都只依赖它。 */
export interface LibraryStorage {
  listFiles(): Promise<StoredFile[]>;
  putFiles(files: StoredFile[]): Promise<void>;
  deleteFiles(paths: string[]): Promise<void>;

  listTracks(): Promise<Track[]>;
  getTrack(cacheKey: string): Promise<Track | undefined>;
  /** 按批写入，避免逐条事务的开销（技术方案 6.3）。 */
  putTracks(tracks: Track[]): Promise<void>;
  deleteTracks(cacheKeys: string[]): Promise<void>;

  getCover(cacheKey: string): Promise<CoverRecord | undefined>;
  putCovers(entries: Array<{ cacheKey: string; cover: CoverRecord }>): Promise<void>;
  deleteCovers(cacheKeys: string[]): Promise<void>;

  readState(): Promise<PlaybackState | undefined>;
  writeState(state: PlaybackState): Promise<void>;

  saveHandle(sourceId: string, handle: unknown): Promise<void>;
  loadHandle(sourceId: string): Promise<unknown | undefined>;
  deleteHandle(sourceId: string): Promise<void>;

  /** 「重置演示」「清空曲库」用：清掉全部缓存与句柄。 */
  clearAll(): Promise<void>;
}

interface QingyinDB extends DBSchema {
  files: { key: string; value: StoredFile };
  tracks: { key: string; value: Track };
  covers: { key: string; value: CoverRecord };
  state: { key: string; value: PlaybackState };
  handles: { key: string; value: unknown };
}

export const DB_NAME = 'qingyin-player';
export const DB_VERSION = 1;
/** 播放状态固定用这一个键。 */
export const STATE_KEY = 'playback';

function wrap(db: IDBPDatabase<QingyinDB>): LibraryStorage {
  return {
    async listFiles() {
      return db.getAll('files');
    },
    async putFiles(files) {
      if (files.length === 0) return;
      const tx = db.transaction('files', 'readwrite');
      for (const file of files) await tx.store.put(file);
      await tx.done;
    },
    async deleteFiles(paths) {
      if (paths.length === 0) return;
      const tx = db.transaction('files', 'readwrite');
      for (const path of paths) await tx.store.delete(path);
      await tx.done;
    },

    async listTracks() {
      return db.getAll('tracks');
    },
    async getTrack(cacheKey) {
      return db.get('tracks', cacheKey);
    },
    async putTracks(tracks) {
      if (tracks.length === 0) return;
      const tx = db.transaction('tracks', 'readwrite');
      for (const track of tracks) await tx.store.put(track, track.cacheKey);
      await tx.done;
    },
    async deleteTracks(cacheKeys) {
      if (cacheKeys.length === 0) return;
      const tx = db.transaction('tracks', 'readwrite');
      for (const cacheKey of cacheKeys) await tx.store.delete(cacheKey);
      await tx.done;
    },

    async getCover(cacheKey) {
      return db.get('covers', cacheKey);
    },
    async putCovers(entries) {
      if (entries.length === 0) return;
      const tx = db.transaction('covers', 'readwrite');
      for (const entry of entries) await tx.store.put(entry.cover, entry.cacheKey);
      await tx.done;
    },
    async deleteCovers(cacheKeys) {
      if (cacheKeys.length === 0) return;
      const tx = db.transaction('covers', 'readwrite');
      for (const cacheKey of cacheKeys) await tx.store.delete(cacheKey);
      await tx.done;
    },

    async readState() {
      return db.get('state', STATE_KEY);
    },
    async writeState(state) {
      await db.put('state', state, STATE_KEY);
    },

    async saveHandle(sourceId, handle) {
      await db.put('handles', handle, sourceId);
    },
    async loadHandle(sourceId) {
      return db.get('handles', sourceId);
    },
    async deleteHandle(sourceId) {
      await db.delete('handles', sourceId);
    },

    async clearAll() {
      const tx = db.transaction(['files', 'tracks', 'covers', 'state', 'handles'], 'readwrite');
      await Promise.all([
        tx.objectStore('files').clear(),
        tx.objectStore('tracks').clear(),
        tx.objectStore('covers').clear(),
        tx.objectStore('state').clear(),
        tx.objectStore('handles').clear(),
      ]);
      await tx.done;
    },
  };
}

/** 浏览器侧的存储实现。 */
export async function indexedDbStorage(): Promise<LibraryStorage> {
  const db = await openDB<QingyinDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('files', { keyPath: 'path' });
      database.createObjectStore('tracks');
      database.createObjectStore('covers');
      database.createObjectStore('state');
      database.createObjectStore('handles');
    },
  });
  return wrap(db);
}

/**
 * 申请持久化存储（技术方案 11 节）。
 *
 * IndexedDB 被浏览器清理时缓存会丢，但缓存不是用户数据，丢了只是重扫一遍，
 * 所以这里失败也不影响功能，只做尽力而为的申请。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage?.persist) return false;
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
