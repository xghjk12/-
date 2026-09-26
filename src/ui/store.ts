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
import { insertAfterCurrent, isValidMode, nextMode, removeQueueItem } from '../core/queue.js';
import type { PlayMode } from '../core/queue.js';
import { filterTracks, buildSearchKey, buildGroupedEntries, sortTracks, tracksToEntries } from '../core/sort.js';
import type { ListEntry } from '../core/sort.js';
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
import { syncLyrics } from '../platform/lyricSync.js';
import type { LyricSyncStats } from '../platform/lyricSync.js';
import type { PlaybackState } from '../platform/storage.js';
import { createPlaybackController } from './playback.js';
import type { PlaybackController, PlaybackSnapshot } from './playback.js';
import { invalidateLyrics } from './lyrics.js';
import { getServices } from './services.js';
import type { Services } from './services.js';

export type LibraryView = 'all' | 'artist' | 'album' | 'recent' | 'played' | 'diagnostics';
export type NoticeKind = 'info' | 'warn' | 'error';
/** 右抽屉的两个标签页。 */
export type DrawerTab = 'queue' | 'lyrics';

/** 播放历史的条数上限：够用又不会把状态记录撑大。 */
export const RECENT_LIMIT = 200;

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
}

export interface ScanStatus {
  /** 本轮扫描的序号：界面与自动化脚本靠它区分"上一轮"和"这一轮"。 */
  runId: number;
  active: boolean;
  /**
   * 扫描阶段。
   *
   * `lyrics` 是刻意单独一档：歌词认领发生在音频扫描**之后**，如果这里直接报 done，
   * 界面与自动化脚本都会以为"已经全部就绪"，从而读到还没写进去的歌词。
   */
  phase: 'idle' | 'listing' | 'parsing' | 'lyrics' | 'done' | 'aborted';
  found: number;
  total: number;
  parsed: number;
  reused: number;
  failed: number;
  currentPath?: string;
  /** 目录遍历（含每个文件取 size/mtime）耗时：大库时这段往往比解析还长。 */
  listingMs: number;
  /** 本轮扫描总耗时。 */
  elapsedMs: number;
  /** 实际读取的字节数——「只读文件头」收益的直接证据。 */
  bytesRead: number;
  /** 清理掉的、已经不在磁盘上的文件数。 */
  removed: number;
  /** 歌词认领单独一步，它的耗时也单独记（数千首时这步要读所有 .lrc）。 */
  lyricSyncMs: number;
  /** 歌词认领的结果统计。 */
  lyricStats?: LyricSyncStats;
  /** 分项耗时：用来回答"这次扫描的时间花在哪了"。 */
  timing: {
    listFilesMs: number;
    cachedTracksMs: number;
    sourceListMs: number;
    loopMs: number;
    cleanupMs: number;
  };
}

const IDLE_TIMING = {
  listFilesMs: 0,
  cachedTracksMs: 0,
  sourceListMs: 0,
  loopMs: 0,
  cleanupMs: 0,
};

const IDLE_SCAN: ScanStatus = {
  runId: 0,
  active: false,
  phase: 'idle',
  found: 0,
  total: 0,
  parsed: 0,
  reused: 0,
  failed: 0,
  listingMs: 0,
  elapsedMs: 0,
  bytesRead: 0,
  removed: 0,
  lyricSyncMs: 0,
  timing: IDLE_TIMING,
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
  /** 分组视图里被收起的分组键（艺术家名或专辑名）。 */
  collapsedGroups: string[];
  /** 最近播放过的曲目身份，最新在前。 */
  recentPaths: string[];

  queue: string[];
  currentIndex: number;
  mode: PlayMode;
  shuffleOrder: number[];
  playing: boolean;
  volume: number;
  muted: boolean;
  durationSec: number;
  /** 右抽屉：关闭 / 队列 / 歌词。 */
  drawer: 'none' | DrawerTab;
  /** 歌词搜索地址模板；默认空（不内置任何具体站点）。 */
  lyricSearchTemplate: string;

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
  /** 收起/展开分组视图里的某个分组。 */
  toggleGroup(groupKey: string): void;
  /** 把某首插到当前曲目之后（"下一首播放"）。 */
  playNext(path: string): void;

  playAt(paths: string[], index: number): Promise<void>;
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  cycleMode(): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  seek(positionSec: number): void;
  toggleQueue(): void;
  toggleLyrics(): void;
  /** 写入歌词：导入文件（`import`）或粘贴文本（`paste`）。 */
  saveLyrics(path: string, text: string, source: 'import' | 'paste'): Promise<void>;
  removeLyrics(path: string): Promise<void>;
  /** 微调时间轴偏移；正值表示歌词提前出现。 */
  nudgeLyricOffset(path: string, deltaSec: number): Promise<void>;
  setLyricSearchTemplate(template: string): Promise<void>;
  /** 手动触发一次"只找歌词"，用于把刚下载的 .lrc 认领进来。 */
  rescanLyrics(): Promise<void>;
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
let scanRunId = 0;
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
  collapsedGroups: [],
  recentPaths: [],
  queue: [],
  currentIndex: -1,
  mode: 'sequence',
  shuffleOrder: [],
  playing: false,
  volume: 0.8,
  muted: false,
  durationSec: 0,
  drawer: 'none',
  lyricSearchTemplate: '',
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
  /** 最近播放顺序（view='played' 时用）。 */
  recentPaths?: readonly string[];
  /** 收起的分组（view='artist' | 'album' 时用）。 */
  collapsedGroups?: readonly string[];
}

/**
 * 视图 → 检索 → 排序 → （必要时分组摊平）→ 混合行列表。
 *
 * 返回混合行而不是曲目数组，是因为**队列必须等于屏幕上看到的顺序**：
 * 分组视图下顺序会被分组打乱，所以播放队列由这个列表里的 track 行依次取出，
 * 而不是另外拿一份排序结果——两份顺序一旦不同，就会出现"双击这首却放了另一首"。
 */
export function visibleEntries(tracks: Track[], options: VisibleOptions): Array<ListEntry<Track>> {
  let list = tracks;

  if (options.view === 'diagnostics') {
    list = list.filter((track) => diagnoseTrack(track) !== undefined);
  } else if (options.view === 'recent') {
    // 「最近添加」按入库时间倒序，最多 200 首
    list = [...list].sort((a, b) => b.addedAt - a.addedAt).slice(0, 200);
  } else if (options.view === 'played') {
    const order = new Map((options.recentPaths ?? []).map((path, index) => [path, index]));
    list = [...list]
      .filter((track) => order.has(track.path))
      .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  }

  const filtered = filterTracks(list, options.query);
  const sorted =
    options.sortKey === 'default' ? filtered : sortTracks(filtered, options.sortKey, options.sortDirection);

  if (options.view === 'artist' || options.view === 'album') {
    return buildGroupedEntries(sorted, options.view, options.collapsedGroups ?? []);
  }
  return tracksToEntries(sorted);
}

/** 混合行列表 → 曲目顺序（播放队列就用它）。 */
export function entryTracks(entries: Array<ListEntry<Track>>): Track[] {
  return entries.filter((entry): entry is { kind: 'track'; track: Track } => entry.kind === 'track').map((entry) => entry.track);
}

export type DiagnosticCode = 'unsupported' | 'parse-error';

export interface Diagnosis {
  code: DiagnosticCode;
  reason: string;
}

/**
 * 判断一首曲目是否需要人工关注，并给出可读原因。
 *
 * 诊段视图不去"猜"太多：只列**能说清原因**的两类——格式浏览器放不出声、标签解析失败。
 * 这样用户看到清单就知道要么换格式要么修标签，而不是面对一堆模棱两可的警告。
 */
export function diagnoseTrack(track: Track): Diagnosis | undefined {
  if (track.parseError) {
    return { code: 'parse-error', reason: `标签读取失败：${track.parseError}` };
  }
  if (track.verdict !== 'decodable') {
    return { code: 'unsupported', reason: track.verdictNote ?? '浏览器无法解码该格式' };
  }
  return undefined;
}

/** 侧栏每个视图的计数。 */
export function viewCounts(
  tracks: Track[],
  recentPaths: readonly string[] = [],
): Record<LibraryView, number> {
  const playableKnown = new Set(tracks.map((track) => track.path));
  return {
    all: tracks.length,
    artist: new Set(tracks.map((track) => track.artist?.trim() || '未知')).size,
    album: new Set(tracks.map((track) => track.album?.trim() || '未知')).size,
    recent: Math.min(tracks.length, 200),
    played: recentPaths.filter((path) => playableKnown.has(path)).length,
    diagnostics: tracks.filter((track) => diagnoseTrack(track) !== undefined).length,
  };
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
      recentPaths: state.recentPaths,
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

    // 记一次播放历史：最新在前、去重、限量
    const recentPaths = track
      ? [track.path, ...get().recentPaths.filter((path) => path !== track.path)].slice(0, RECENT_LIMIT)
      : get().recentPaths;

    set({
      resumePath: track?.path,
      resumePositionSec: positionSec,
      durationSec: 0,
      recentPaths,
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

  async function runScan(
    source: BrowserMusicSource,
    handle?: DirectoryHandleLike,
    listingMs = 0,
  ): Promise<void> {
    if (!services) return;
    scanAbort = new AbortController();
    currentSource = source;
    let lyricSyncMs = 0;
    if (handle) await services.storage.saveHandle(MUSIC_SOURCE_ID, handle);

    scanRunId += 1;
    set({
      scan: { ...IDLE_SCAN, runId: scanRunId, active: true, phase: 'listing', listingMs },
      rootName: source.rootName,
    });

    const result = await scanLibrary({
      storage: services.storage,
      source,
      signal: scanAbort.signal,
      onProgress: (progress) => {
        const settled = progress.phase === 'done' || progress.phase === 'aborted';
        set({
          scan: {
            // 沿用本轮已有的统计（listingMs 等），只更新进度字段
            ...get().scan,
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
        runId: scanRunId,
        active: false,
        phase: stats.aborted ? 'aborted' : 'done',
        found: stats.total,
        total: stats.total,
        parsed: stats.parsed,
        reused: stats.reused,
        failed: stats.failed,
        listingMs,
        elapsedMs: stats.elapsedMs,
        bytesRead: stats.bytesRead,
        removed: stats.removed,
        lyricSyncMs,
        timing: stats.timing,
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
          `遍历 ${(listingMs / 1000).toFixed(1)}s + 扫描 ${(stats.elapsedMs / 1000).toFixed(1)}s`,
      );
    }

    // 歌词：把目录里的 .lrc 认领到曲目上（用户导入/粘贴的歌词不会被覆盖）。
    // 这一步仍然算"扫描进行中"，否则界面与自动化脚本会以为已经就绪。
    set({ scan: { ...get().scan, active: true, phase: 'lyrics' } });
    const lyricStart = Date.now();
    const lyricStats = await syncLyrics({
      storage: services.storage,
      source,
      tracks: result.tracks,
    });
    lyricSyncMs = Date.now() - lyricStart;
    set({
      scan: {
        ...get().scan,
        active: false,
        phase: stats.aborted ? 'aborted' : 'done',
        lyricSyncMs,
        lyricStats,
      },
    });
    invalidateLyrics();
    if (lyricStats.claimed + lyricStats.updated > 0 || lyricStats.unmatched + lyricStats.ambiguous > 0) {
      const missed = lyricStats.unmatched + lyricStats.ambiguous;
      pushNotice(
        `歌词：认领 ${lyricStats.claimed + lyricStats.updated} 首` +
          (missed > 0 ? `，${missed} 个文件没匹配上（可在歌词面板手动导入）` : ''),
      );
    }

    await restorePlayback();
  }

  /** 遍历目录并计时：这段（每个文件取一次 size/mtime）在大库上可能比解析还长。 */
  async function collect(
    handle: DirectoryHandleLike,
  ): Promise<{ source: BrowserMusicSource; listingMs: number }> {
    const startedAt = Date.now();
    const source = await collectFromDirectoryHandle(handle, (found) =>
      set({ scan: { ...IDLE_SCAN, active: true, phase: 'listing', found } }),
    );
    return { source, listingMs: Date.now() - startedAt };
  }

  /** 目录失效要给出可执行的下一步，而不是把 DOMException 的名字丢给用户。 */
  function sourceErrorMessage(error: unknown): string {
    if (error instanceof DOMException) {
      if (error.name === 'NotFoundError')
        return '目录已移动或被删除，请重新选择音乐文件夹（已缓存的曲库仍保留）';
      if (error.name === 'NotAllowedError') return '没有拿到目录读取权限，请重新选择音乐文件夹';
      if (error.name === 'AbortError') return '已取消选择文件夹';
    }
    return error instanceof Error ? error.message : String(error);
  }

  return {
    ...INITIAL,

    async boot() {
      if (get().ready) return;
      // booting 只用来合并"同一时刻的并发调用"；完成后必须清掉，
      // 否则「清空曲库」之后或测试里重置状态之后再调 boot 会拿到一个已经过期的 promise，
      // 于是什么都不做、界面永远停在未就绪。
      booting ??= (async () => {
        services = await getServices();
        const [saved, cached, handle, settings] = await Promise.all([
          services.storage.readState(),
          services.storage.listTracks(),
          services.storage.loadHandle(MUSIC_SOURCE_ID),
          services.storage.readSettings(),
        ]);

        // 旧版本缓存里的曲目没有检索键（没有拼音首字母）：在内存里补算一次，
        // 免得每次敲键都为几千首现算。下次扫描入库时会自然带上。
        const tracks = cached.map((track) =>
          track.searchKey
            ? track
            : {
                ...track,
                searchKey: buildSearchKey({
                  title: track.title,
                  artist: track.artist,
                  album: track.album,
                }),
              },
        );

        engine = createAudioEngine(engineHandlers());
        controller = createPlaybackController(playbackEnv());

        engine.setVolume(saved?.volume ?? INITIAL.volume);
        engine.setMuted(saved?.muted ?? false);

        set({
          ready: true,
          persistent: services.persistent,
          tracks,
          volume: saved?.volume ?? INITIAL.volume,
          muted: saved?.muted ?? false,
          mode: saved?.mode && isValidMode(saved.mode) ? saved.mode : 'sequence',
          resumePath: saved?.trackPath,
          resumePositionSec: saved?.positionSec ?? 0,
          recentPaths: saved?.recentPaths ?? [],
          lyricSearchTemplate: settings?.lyricSearchTemplate ?? '',
          canRestore: Boolean(handle),
        });

        // 页面隐藏、以及即将卸载时各补写一次进度（技术方案 8.4）。
        // 用 pagehide 而不是 beforeunload：它在 bfcache 与移动端切后台时都会触发。
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) void services?.writer.flush();
        });
        window.addEventListener('pagehide', () => {
          void services?.writer.flush();
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

      try {
        await booting;
      } finally {
        booting = undefined;
      }
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
        const collected = await collect(handle);
        await runScan(collected.source, handle, collected.listingMs);
      } catch (error) {
        set({ scan: IDLE_SCAN });
        pushNotice(sourceErrorMessage(error), error instanceof DOMException && error.name === 'AbortError' ? 'info' : 'error');
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
        const collected = await collect(handle);
        await runScan(collected.source, handle, collected.listingMs);
      } catch (error) {
        set({ scan: IDLE_SCAN });
        pushNotice(sourceErrorMessage(error), 'error');
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

    toggleGroup(groupKey) {
      const collapsed = get().collapsedGroups;
      set({
        collapsedGroups: collapsed.includes(groupKey)
          ? collapsed.filter((key) => key !== groupKey)
          : [...collapsed, groupKey],
      });
    },

    playNext(path) {
      const { queue, currentIndex, tracks } = get();
      const title = tracks.find((track) => track.path === path)?.title ?? path;

      // 队列还是空的：直接当"从这首开始播"，否则用户会以为按钮没反应
      if (queue.length === 0) {
        void get().playAt([path], 0);
        return;
      }

      const result = insertAfterCurrent(queue, currentIndex, path);
      set({ queue: result.queue, currentIndex: result.currentIndex });
      pushNotice(`下一首播放：${title}`);
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
      set({ drawer: get().drawer === 'queue' ? 'none' : 'queue' });
    },

    toggleLyrics() {
      set({ drawer: get().drawer === 'lyrics' ? 'none' : 'lyrics' });
    },

    async saveLyrics(path, text, source) {
      if (!services) await get().boot();
      const existing = await services!.storage.getLyrics(path);
      await services!.storage.putLyrics([
        {
          path,
          text,
          source,
          // 导入/粘贴的来源要清掉 sidecar 关联，否则下次扫描会以为这是派生记录
          userOffsetSec: existing?.userOffsetSec ?? 0,
          updatedAt: Date.now(),
        },
      ]);
      invalidateLyrics(path);
      const title = get().tracks.find((track) => track.path === path)?.title ?? path;
      pushNotice(`${source === 'import' ? '已导入' : '已粘贴'}歌词：${title}`);
    },

    async removeLyrics(path) {
      if (!services) await get().boot();
      await services!.storage.deleteLyrics([path]);
      invalidateLyrics(path);
      pushNotice('已移除歌词（下次扫描会重新认领同名 .lrc）');
    },

    async nudgeLyricOffset(path, deltaSec) {
      if (!services) await get().boot();
      const record = await services!.storage.getLyrics(path);
      if (!record) return;
      const next = Math.round((record.userOffsetSec + deltaSec) * 100) / 100;
      await services!.storage.putLyrics([{ ...record, userOffsetSec: next, updatedAt: Date.now() }]);
      invalidateLyrics(path);
    },

    async setLyricSearchTemplate(template) {
      if (!services) await get().boot();
      const trimmed = template.trim();
      set({ lyricSearchTemplate: trimmed });
      await services!.storage.writeSettings({ lyricSearchTemplate: trimmed });
      pushNotice(trimmed ? '已保存歌词搜索地址模板' : '已清空歌词搜索地址模板');
    },

    async rescanLyrics() {
      if (!services || !currentSource) {
        pushNotice('还没有曲库来源，请先选择音乐文件夹', 'warn');
        return;
      }
      set({ scan: { ...IDLE_SCAN, active: true, phase: 'listing' } });
      const stats = await syncLyrics({
        storage: services.storage,
        source: currentSource,
        tracks: get().tracks,
      });
      set({ scan: IDLE_SCAN });
      invalidateLyrics();
      pushNotice(
        `歌词扫描：新认领 ${stats.claimed}、更新 ${stats.updated}、未变化 ${stats.unchanged}` +
          `${stats.unmatched + stats.ambiguous > 0 ? `，${stats.unmatched + stats.ambiguous} 个文件没匹配上` : ''}`,
      );
    },

    removeFromQueue(index) {
      const { queue, currentIndex } = get();
      if (index < 0 || index >= queue.length) return;

      const result = removeQueueItem(queue, currentIndex, index);
      if (result.removedCurrent) {
        // 移除当前曲目：停止播放，等用户重新点播（与 Demo 行为一致）
        engine?.pause();
      }
      set({ queue: result.queue, currentIndex: result.currentIndex });
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

/** 自检与调试用：当前曲库来源（用来确认浏览器到底把哪些文件交进来了）。 */
export function getActiveSource(): BrowserMusicSource | undefined {
  return currentSource;
}
