/**
 * 应用状态（Zustand）。
 *
 * 边界按技术方案 7.2 划：
 *  - 进 store：曲库列表、当前曲目、音量、播放模式、视图与筛选（低频变化，需要驱动 UI）
 *  - **不进 store：播放进度**。进度每秒变好几次，进 React state 会让整棵列表跟着重渲染；
 *    这里把它放在模块级变量 `livePositionSec` 里，由 `PlayerBar` 用 rAF 直接改 DOM。
 *  - 搜索输入放组件本地（高频），防抖之后才写进 store。
 *
 * 播放引擎、播放编排器、曲库来源、IndexedDB 句柄都放在模块级变量里而不是 store 里：
 * 它们不是可序列化状态，重建它们等于把正在放的歌打断。
 */
import { create } from 'zustand';
import { isValidMode, nextMode } from '../core/queue.js';
import type { PlayMode } from '../core/queue.js';
import { filterTracks, sortTracks } from '../core/sort.js';
import type { SortDirection, Track, TrackSortKey } from '../core/track.js';
import { createAudioEngine } from '../platform/audioEngine.js';
import type { AudioEngine } from '../platform/audioEngine.js';
import {
  collectFromDirectoryHandle,
  ensureReadPermission,
  getDirectoryPicker,
  MUSIC_SOURCE_ID,
  sourceFromFileList,
} from '../platform/browserMusicSource.js';
import type { BrowserMusicSource, DirectoryHandleLike } from '../platform/browserMusicSource.js';
import {
  bindMediaSessionHandlers,
  clearNowPlaying,
  setPlaybackState,
  updateNowPlaying,
  updatePositionState,
} from '../platform/mediaSession.js';
import { scanLibrary } from '../platform/scanner.js';
import type { PlaybackState } from '../platform/storage.js';
import { createPlaybackController } from './playback.js';
import type { PlaybackController, PlaybackSnapshot } from './playback.js';
import { getServices } from './services.js';
import type { Services } from './services.js';

export type LibraryView = 'all' | 'recent' | 'unsupported';
export type NoticeKind = 'info' | 'warn' | 'error';

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
}

export interface ScanStatus {
  active: boolean;
  phase: 'idle' | 'listing' | 'parsing' | 'done' | 'aborted';
  found: number;
  total: number;
  parsed: number;
  reused: number;
  failed: number;
  currentPath?: string;
}

const IDLE_SCAN: ScanStatus = {
  active: false,
  phase: 'idle',
  found: 0,
  total: 0,
  parsed: 0,
  reused: 0,
  failed: 0,
};

export const MODE_TEXT: Record<PlayMode, string> = {
  sequence: '顺序播放',
  'repeat-all': '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
};

export interface AppState {
  ready: boolean;
  /** 用的是真 IndexedDB 还是内存降级实现。 */
  persistent: boolean;

  tracks: Track[];
  rootName: string;
  /** 当前会话有没有可用的曲库来源（内存里的 File 映射）。 */
  hasSource: boolean;
  /** 之前存过目录句柄，可以「一键恢复曲库」。 */
  canRestore: boolean;
  scan: ScanStatus;

  query: string;
  sortKey: TrackSortKey;
  sortDirection: SortDirection;
  view: LibraryView;
  selectedPath?: string;

  queue: string[];
  currentIndex: number;
  mode: PlayMode;
  shuffleOrder: number[];
  playing: boolean;
  volume: number;
  muted: boolean;
  durationSec: number;
  queueOpen: boolean;

  /** 上次播放到的曲目与进度（只在切歌 / 暂停时更新），用于「继续上次播放」。 */
  resumePath?: string;
  resumePositionSec: number;

  notices: Notice[];
}

export interface AppActions {
  boot(): Promise<void>;
  pickDirectory(): Promise<void>;
  restoreLibrary(): Promise<void>;
  useFileList(files: FileList): Promise<void>;
  cancelScan(): void;
  clearLibrary(): Promise<void>;

  setQuery(query: string): void;
  setSort(key: TrackSortKey): void;
  setView(view: LibraryView): void;
  select(path: string | undefined): void;

  playAt(paths: string[], index: number): Promise<void>;
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  cycleMode(): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  seek(positionSec: number): void;
  toggleQueue(): void;
  removeFromQueue(index: number): void;
  clearQueue(): void;
  jumpToQueue(index: number): Promise<void>;
  /** 恢复上次播放：加载但不自动播放。 */
  resumeLast(): Promise<void>;

  pushNotice(message: string, kind?: NoticeKind): void;
  dismissNotice(id: number): void;
}

export type AppStore = AppState & AppActions;

/* ==================== 模块级运行时 ==================== */

let engine: AudioEngine | undefined;
let controller: PlaybackController | undefined;
let currentSource: BrowserMusicSource | undefined;
let services: Services | undefined;
let scanAbort: AbortController | undefined;
let booting: Promise<void> | undefined;
let noticeSeq = 0;
/** 播放进度：高频变化，刻意留在 React 之外。 */
let livePositionSec = 0;
/** MediaSession 封面用过的对象 URL，切歌时要 revoke。 */
let artworkUrl: string | undefined;

const INITIAL: AppState = {
  ready: false,
  persistent: true,
  tracks: [],
  rootName: '',
  hasSource: false,
  canRestore: false,
  scan: IDLE_SCAN,
  query: '',
  sortKey: 'default',
  sortDirection: 'asc',
  view: 'all',
  selectedPath: undefined,
  queue: [],
  currentIndex: -1,
  mode: 'sequence',
  shuffleOrder: [],
  playing: false,
  volume: 0.8,
  muted: false,
  durationSec: 0,
  queueOpen: false,
  resumePath: undefined,
  resumePositionSec: 0,
  notices: [],
};

/* ==================== 派生数据（纯函数，组件用 useMemo 调） ==================== */

export interface VisibleOptions {
  query: string;
  sortKey: TrackSortKey;
  sortDirection: SortDirection;
  view: LibraryView;
}

/** 视图 → 检索 → 排序。`sortKey` 为 default 时保留视图自带顺序。 */
export function visibleTracks(tracks: Track[], options: VisibleOptions): Track[] {
  let list = tracks;

  if (options.view === 'unsupported') {
    list = list.filter((track) => track.verdict !== 'decodable');
  } else if (options.view === 'recent') {
    list = [...list].sort((a, b) => b.addedAt - a.addedAt).slice(0, 200);
  }

  const filtered = filterTracks(list, options.query);
  if (options.sortKey === 'default') return filtered;
  return sortTracks(filtered, options.sortKey, options.sortDirection);
}

export function libraryStats(tracks: Track[]): {
  total: number;
  durationSec: number;
  artists: number;
  albums: number;
  unsupported: number;
} {
  const artists = new Set<string>();
  const albums = new Set<string>();
  let durationSec = 0;
  let unsupported = 0;

  for (const track of tracks) {
    durationSec += track.durationSec ?? 0;
    if (track.artist) artists.add(track.artist);
    if (track.album) albums.add(track.album);
    if (track.verdict !== 'decodable') unsupported += 1;
  }

  return {
    total: tracks.length,
    durationSec,
    artists: artists.size,
    albums: albums.size,
    unsupported,
  };
}

/* ==================== store ==================== */

export const useAppStore = create<AppStore>()((set, get) => {
  function pushNotice(message: string, kind: NoticeKind = 'info'): void {
    noticeSeq += 1;
    const notice: Notice = { id: noticeSeq, message, kind };
    set((state) => ({ notices: [...state.notices.slice(-3), notice] }));
    setTimeout(() => get().dismissNotice(notice.id), kind === 'info' ? 3200 : 6000);
  }

  function payload(positionSec: number): PlaybackState {
    const state = get();
    return {
      volume: state.volume,
      muted: state.muted,
      mode: state.mode,
      trackPath: state.resumePath,
      positionSec,
      updatedAt: Date.now(),
    };
  }

  /** 节流写入；immediate 用于音量 / 模式这类低频变化。 */
  function persist(options: { immediate?: boolean } = {}): void {
    if (!services) return;
    const state = payload(livePositionSec);
    void (options.immediate ? services.writer.saveNow(state) : services.writer.save(state));
  }

  function releaseArtwork(): void {
    if (artworkUrl) {
      URL.revokeObjectURL(artworkUrl);
      artworkUrl = undefined;
    }
  }

  function applyTrack(track: Track | undefined, positionSec: number): void {
    livePositionSec = positionSec;
    releaseArtwork();

    set({
      resumePath: track?.path,
      resumePositionSec: positionSec,
      durationSec: 0,
      ...(track ? { selectedPath: track.path } : {}),
    });

    if (!track) {
      clearNowPlaying();
      document.title = '轻音播放';
      persist({ immediate: true });
      return;
    }

    document.title = `${track.title} - 轻音播放`;
    const base = { title: track.title, artist: track.artist, album: track.album };
    // 先用文字信息更新，封面异步补上：不能因为读封面让锁屏信息迟迟不出现
    updateNowPlaying(base);
    if (track.hasCover) void loadArtwork(track);
    persist();
  }

  async function loadArtwork(track: Track): Promise<void> {
    if (!services) return;
    const cover = await services.storage.getCover(track.cacheKey);
    if (!cover || get().resumePath !== track.path) return;
    artworkUrl = URL.createObjectURL(cover.data);
    updateNowPlaying({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artworkUrl,
    });
  }

  function engineHandlers() {
    return {
      onTimeUpdate: (positionSec: number, durationSec: number) => {
        livePositionSec = positionSec;
        if (Number.isFinite(durationSec) && durationSec > 0 && durationSec !== get().durationSec) {
          set({ durationSec });
        }
        // 只做节流持久化与系统媒体进度，绝不把进度写进 store
        persist();
        updatePositionState(positionSec, durationSec);
      },
      onDurationChange: (durationSec: number) => {
        if (Number.isFinite(durationSec) && durationSec > 0) set({ durationSec });
      },
      onPlayStateChange: (playing: boolean) => {
        set({ playing });
        setPlaybackState(playing ? 'playing' : 'paused');
        // 暂停时补一次进度（技术方案 8.4）
        if (!playing) {
          set({ resumePositionSec: livePositionSec });
          void services?.writer.flush();
        }
      },
      onEnded: () => {
        void controller?.next({ auto: true });
      },
      onError: (message: string) => pushNotice(message, 'error'),
    };
  }

  function playbackEnv() {
    return {
      getPlayback: (): PlaybackSnapshot => {
        const state = get();
        return {
          queue: state.queue,
          currentIndex: state.currentIndex,
          mode: state.mode,
          shuffleOrder: state.shuffleOrder,
        };
      },
      setPlayback: (patch: Partial<PlaybackSnapshot>) => set(patch),
      getTrack: (path: string) => get().tracks.find((track) => track.path === path),
      openSource: async (track: Track) => {
        // 播放走原始 File，交给 <audio> 的对象 URL，不会把整个文件读进内存
        const file = currentSource?.getFile(track.path);
        return file ? { blob: file } : undefined;
      },
      getEngine: () => {
        if (!engine) throw new Error('播放引擎尚未初始化');
        return engine;
      },
      onPlayingChange: (playing: boolean) => set({ playing }),
      onTrackChange: (track: Track | undefined, positionSec: number) =>
        applyTrack(track, positionSec),
      onProgress: (track: Track | undefined, positionSec: number) => {
        livePositionSec = positionSec;
        persist();
        if (track) updatePositionState(positionSec, get().durationSec);
      },
      onNotice: (message: string, kind: 'info' | 'warn') => pushNotice(message, kind),
    };
  }

  /** 扫描完成后，如果上次播放的曲目还在库里，就把它加载回来（不自动播放）。 */
  async function restorePlayback(): Promise<void> {
    const state = get();
    const path = state.resumePath;
    if (!path || !state.tracks.some((track) => track.path === path)) return;
    const index = state.tracks.findIndex((track) => track.path === path);
    await controller?.start(
      state.tracks.map((track) => track.path),
      index,
      { positionSec: state.resumePositionSec, autoplay: false },
    );
  }

  async function runScan(source: BrowserMusicSource, handle?: DirectoryHandleLike): Promise<void> {
    if (!services) return;
    scanAbort = new AbortController();
    currentSource = source;
    if (handle) await services.storage.saveHandle(MUSIC_SOURCE_ID, handle);

    set({ scan: { ...IDLE_SCAN, active: true, phase: 'listing' }, rootName: source.rootName });

    const result = await scanLibrary({
      storage: services.storage,
      source,
      signal: scanAbort.signal,
      onProgress: (progress) => {
        const settled = progress.phase === 'done' || progress.phase === 'aborted';
        set({
          scan: {
            active: !settled,
            phase: progress.phase,
            found: progress.found,
            total: progress.total,
            parsed: progress.parsed,
            reused: progress.reused,
            failed: progress.failed,
            currentPath: progress.currentPath,
          },
        });
      },
    });

    scanAbort = undefined;
    const { stats } = result;

    set({
      tracks: result.tracks,
      hasSource: true,
      canRestore: Boolean(handle) || get().canRestore,
      scan: {
        active: false,
        phase: stats.aborted ? 'aborted' : 'done',
        found: stats.total,
        total: stats.total,
        parsed: stats.parsed,
        reused: stats.reused,
        failed: stats.failed,
      },
    });

    // 文件可能已经被删除或改名，队列里不能留下幽灵条目
    const alive = new Set(result.tracks.map((track) => track.path));
    set({ queue: get().queue.filter((path) => alive.has(path)) });

    if (stats.aborted) {
      pushNotice(`扫描已取消：已入库 ${stats.parsed + stats.reused} 首`, 'warn');
    } else {
      const megabytes = (stats.bytesRead / 1024 / 1024).toFixed(1);
      pushNotice(
        `曲库就绪：${stats.total} 首（缓存命中 ${stats.reused}、新解析 ${stats.parsed}` +
          `${stats.removed ? `、清理 ${stats.removed}` : ''}），读取 ${megabytes}MB，` +
          `耗时 ${(stats.elapsedMs / 1000).toFixed(1)}s`,
      );
    }

    await restorePlayback();
  }

  async function collect(
    handle: DirectoryHandleLike,
  ): Promise<BrowserMusicSource> {
    return collectFromDirectoryHandle(handle, (found) =>
      set({ scan: { ...IDLE_SCAN, active: true, phase: 'listing', found } }),
    );
  }

  return {
    ...INITIAL,

    async boot() {
      if (get().ready) return;
      if (booting) return booting;
      booting = (async () => {
        services = await getServices();
        const [saved, cached, handle] = await Promise.all([
          services.storage.readState(),
          services.storage.listTracks(),
          services.storage.loadHandle(MUSIC_SOURCE_ID),
        ]);

        engine = createAudioEngine(engineHandlers());
        controller = createPlaybackController(playbackEnv());

        engine.setVolume(saved?.volume ?? INITIAL.volume);
        engine.setMuted(saved?.muted ?? false);

        set({
          ready: true,
          persistent: services.persistent,
          tracks: cached,
          volume: saved?.volume ?? INITIAL.volume,
          muted: saved?.muted ?? false,
          mode: saved?.mode && isValidMode(saved.mode) ? saved.mode : 'sequence',
          resumePath: saved?.trackPath,
          resumePositionSec: saved?.positionSec ?? 0,
          canRestore: Boolean(handle),
        });

        // 页面隐藏时补一次进度（技术方案 8.4）
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) void services?.writer.flush();
        });

        bindMediaSessionHandlers({
          play: () => void controller?.toggle(),
          pause: () => engine?.pause(),
          nextTrack: () => void controller?.next(),
          previousTrack: () => void controller?.previous(),
          seekTo: (time: number) => controller?.seek(time),
          seekBackward: (offset: number) =>
            controller?.seek(Math.max(0, (engine?.positionSec ?? 0) - offset)),
          seekForward: (offset: number) =>
            controller?.seek((engine?.positionSec ?? 0) + offset),
        });
      })();
      return booting;
    },

    async pickDirectory() {
      const picker = getDirectoryPicker();
      if (!picker) {
        pushNotice('当前浏览器不支持目录选择（需要 Chrome / Edge），请用「兼容模式」', 'warn');
        return;
      }
      try {
        const handle = await picker({ mode: 'read' });
        set({ scan: { ...IDLE_SCAN, active: true, phase: 'listing' } });
        await runScan(await collect(handle), handle);
      } catch (error) {
        set({ scan: IDLE_SCAN });
        if (error instanceof DOMException && error.name === 'AbortError') {
          pushNotice('已取消选择文件夹');
          return;
        }
        pushNotice(`目录选择失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },

    async restoreLibrary() {
      if (!services) await get().boot();
      const handle = (await services!.storage.loadHandle(MUSIC_SOURCE_ID)) as
        | DirectoryHandleLike
        | undefined;
      if (!handle) {
        set({ canRestore: false });
        pushNotice('没有可恢复的曲库，请先选择音乐文件夹', 'warn');
        return;
      }
      try {
        if (!(await ensureReadPermission(handle))) {
          pushNotice('没有拿到目录读取权限，请重新选择文件夹', 'warn');
          return;
        }
        set({ scan: { ...IDLE_SCAN, active: true, phase: 'listing' } });
        await runScan(await collect(handle), handle);
      } catch (error) {
        set({ scan: IDLE_SCAN });
        pushNotice(`恢复曲库失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },

    async useFileList(files) {
      if (files.length === 0) return;
      if (!services) await get().boot();
      try {
        await runScan(sourceFromFileList(files));
        pushNotice('兼容模式的曲库刷新页面后需要重新选择文件夹');
      } catch (error) {
        set({ scan: IDLE_SCAN });
        pushNotice(`扫描失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },

    cancelScan() {
      scanAbort?.abort();
    },

    async clearLibrary() {
      if (!services) await get().boot();
      engine?.pause();
      await services!.storage.clearAll();
      services!.writer.dispose();
      services!.covers.clear();
      currentSource = undefined;
      releaseArtwork();
      const { volume, muted, mode } = get();
      set({ ...INITIAL, ready: true, persistent: services!.persistent, volume, muted, mode });
      clearNowPlaying();
      document.title = '轻音播放';
      pushNotice('已清空曲库与本地缓存');
    },

    setQuery(query) {
      set({ query });
    },

    setSort(key) {
      const state = get();
      if (state.sortKey === key && key !== 'default') {
        set({ sortDirection: state.sortDirection === 'asc' ? 'desc' : 'asc' });
        return;
      }
      set({ sortKey: key, sortDirection: 'asc' });
    },

    setView(view) {
      set({ view });
    },

    select(path) {
      set({ selectedPath: path });
    },

    async playAt(paths, index) {
      if (!controller) await get().boot();
      await controller?.start(paths, index);
    },

    async togglePlay() {
      if (!controller) await get().boot();
      await controller?.toggle();
    },

    async next() {
      await controller?.next();
    },

    async previous() {
      await controller?.previous();
    },

    cycleMode() {
      const mode = nextMode(get().mode);
      set({ mode });
      if (mode === 'shuffle') controller?.reshuffle();
      persist({ immediate: true });
      pushNotice(`播放模式：${MODE_TEXT[mode]}`);
    },

    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume));
      const muted = clamped === 0 ? true : false;
      set({ volume: clamped, muted });
      engine?.setVolume(clamped);
      engine?.setMuted(muted);
      persist({ immediate: true });
    },

    toggleMute() {
      const muted = !get().muted;
      set({ muted });
      engine?.setMuted(muted);
      persist({ immediate: true });
    },

    seek(positionSec) {
      controller?.seek(positionSec);
    },

    toggleQueue() {
      set({ queueOpen: !get().queueOpen });
    },

    removeFromQueue(index) {
      const { queue, currentIndex } = get();
      if (index < 0 || index >= queue.length) return;
      const nextQueue = queue.filter((_, position) => position !== index);

      if (index === currentIndex) {
        // 移除当前曲目：停止播放，等用户重新点播（与 Demo 行为一致）
        engine?.pause();
        set({ queue: nextQueue, currentIndex: -1 });
        return;
      }
      set({
        queue: nextQueue,
        currentIndex: index < currentIndex ? currentIndex - 1 : currentIndex,
      });
    },

    clearQueue() {
      engine?.pause();
      set({ queue: [], currentIndex: -1, shuffleOrder: [] });
      applyTrack(undefined, 0);
    },

    async jumpToQueue(index) {
      const { queue } = get();
      if (index < 0 || index >= queue.length) return;
      if (!controller) await get().boot();
      await controller?.start(queue, index);
    },

    async resumeLast() {
      if (!controller) await get().boot();
      await restorePlayback();
    },

    pushNotice,
    dismissNotice(id) {
      set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
    },
  };
});

/** 播放进度读取（React 之外）：给 rAF 驱动的进度条用。 */
export function readLiveProgress(): { positionSec: number; durationSec: number } {
  return {
    positionSec: engine?.positionSec ?? 0,
    durationSec: engine?.durationSec ?? 0,
  };
}

/** 自检与调试用：拿到引擎正在使用的 `<audio>` 元素（它不在 DOM 树里）。 */
export function getAudioElement(): HTMLAudioElement | undefined {
  return engine?.element;
}
