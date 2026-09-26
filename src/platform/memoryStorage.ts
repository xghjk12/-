/**
 * 内存版存储：给测试与「IndexedDB 不可用」的降级场景用。
 *
 * 与 `indexedDbStorage()` 实现同一个 `LibraryStorage` 接口，所以扫描逻辑的测试
 * （缓存命中、增量更新、孤儿清理、取消）都能在 Node 里跑，不需要真浏览器。
 */
import type { LibraryStorage, CoverRecord, PlaybackState, StoredFile } from './storage.js';
import type { Track } from '../core/track.js';

export interface MemoryStorageOptions {
  files?: StoredFile[];
  tracks?: Track[];
  covers?: Array<{ cacheKey: string; cover: CoverRecord }>;
  state?: PlaybackState;
  handles?: Record<string, unknown>;
}

/** 额外暴露内部数据，便于测试直接检查"库里到底留了什么"。 */
export interface MemoryStorage extends LibraryStorage {
  readonly fileCount: number;
  readonly trackCount: number;
  readonly coverCount: number;
  hasCover(cacheKey: string): boolean;
}

export function memoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const files = new Map<string, StoredFile>();
  const tracks = new Map<string, Track>();
  const covers = new Map<string, CoverRecord>();
  const handles = new Map<string, unknown>();
  let state = options.state;

  for (const file of options.files ?? []) files.set(file.path, file);
  for (const track of options.tracks ?? []) tracks.set(track.cacheKey, track);
  for (const entry of options.covers ?? []) covers.set(entry.cacheKey, entry.cover);
  for (const [key, value] of Object.entries(options.handles ?? {})) handles.set(key, value);

  return {
    get fileCount() {
      return files.size;
    },
    get trackCount() {
      return tracks.size;
    },
    get coverCount() {
      return covers.size;
    },
    hasCover(cacheKey) {
      return covers.has(cacheKey);
    },

    async listFiles() {
      return [...files.values()];
    },
    async putFiles(next) {
      for (const file of next) files.set(file.path, file);
    },
    async deleteFiles(paths) {
      for (const path of paths) files.delete(path);
    },

    async listTracks() {
      return [...tracks.values()];
    },
    async getTrack(cacheKey) {
      return tracks.get(cacheKey);
    },
    async putTracks(next) {
      for (const track of next) tracks.set(track.cacheKey, track);
    },
    async deleteTracks(cacheKeys) {
      for (const cacheKey of cacheKeys) tracks.delete(cacheKey);
    },

    async getCover(cacheKey) {
      return covers.get(cacheKey);
    },
    async putCovers(entries) {
      for (const entry of entries) covers.set(entry.cacheKey, entry.cover);
    },
    async deleteCovers(cacheKeys) {
      for (const cacheKey of cacheKeys) covers.delete(cacheKey);
    },

    async readState() {
      return state;
    },
    async writeState(next) {
      state = next;
    },

    async saveHandle(sourceId, handle) {
      handles.set(sourceId, handle);
    },
    async loadHandle(sourceId) {
      return handles.get(sourceId);
    },
    async deleteHandle(sourceId) {
      handles.delete(sourceId);
    },

    async clearAll() {
      files.clear();
      tracks.clear();
      covers.clear();
      handles.clear();
      state = undefined;
    },
  };
}
