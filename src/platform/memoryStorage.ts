/**
 * 内存版存储：给测试与「IndexedDB 不可用」的降级场景用。
 *
 * 与 `indexedDbStorage()` 实现同一个 `LibraryStorage` 接口，所以扫描逻辑的测试
 * （缓存命中、增量更新、孤儿清理、取消）都能在 Node 里跑，不需要真浏览器。
 */
import type {
  AppSettings,
  LibraryStorage,
  CoverRecord,
  LyricRecord,
  PlaybackState,
  StoredFile,
} from './storage.js';
import type { Track } from '../core/track.js';

export interface MemoryStorageOptions {
  files?: StoredFile[];
  tracks?: Track[];
  covers?: Array<{ cacheKey: string; cover: CoverRecord }>;
  lyrics?: LyricRecord[];
  settings?: AppSettings;
  state?: PlaybackState;
  handles?: Record<string, unknown>;
}

/** 额外暴露内部数据，便于测试直接检查"库里到底留了什么"。 */
export interface MemoryStorage extends LibraryStorage {
  readonly fileCount: number;
  readonly trackCount: number;
  readonly coverCount: number;
  readonly lyricCount: number;
  hasCover(cacheKey: string): boolean;
  getLyricsText(path: string): string | undefined;
}

export function memoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const files = new Map<string, StoredFile>();
  const tracks = new Map<string, Track>();
  const covers = new Map<string, CoverRecord>();
  const lyrics = new Map<string, LyricRecord>();
  const handles = new Map<string, unknown>();
  let state = options.state;
  let settings = options.settings;

  for (const file of options.files ?? []) files.set(file.path, file);
  for (const track of options.tracks ?? []) tracks.set(track.cacheKey, track);
  for (const entry of options.covers ?? []) covers.set(entry.cacheKey, entry.cover);
  for (const record of options.lyrics ?? []) lyrics.set(record.path, record);
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
    get lyricCount() {
      return lyrics.size;
    },
    hasCover(cacheKey) {
      return covers.has(cacheKey);
    },
    getLyricsText(path) {
      return lyrics.get(path)?.text;
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

    async getLyrics(path) {
      return lyrics.get(path);
    },
    async listLyrics() {
      return [...lyrics.values()];
    },
    async putLyrics(records) {
      for (const record of records) lyrics.set(record.path, record);
    },
    async deleteLyrics(paths) {
      for (const path of paths) lyrics.delete(path);
    },

    async readSettings() {
      return settings;
    },
    async writeSettings(next) {
      settings = next;
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
      lyrics.clear();
      handles.clear();
      state = undefined;
      settings = undefined;
    },
  };
}
