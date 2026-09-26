/**
 * 应用外壳：布局、启动、键盘快捷键、扫描进度、空状态与提示。
 *
 * 启动流程（M3 的"打开就有库"）：
 *  1. 从 IndexedDB 读播放状态与缓存的曲目 → 列表立刻可见，完全不碰音频文件
 *  2. 检查有没有持久化的目录句柄 → 有就显示「恢复曲库」（浏览器要求一次点击重新授权）
 *  3. 扫描结束后如果上次播放的曲目还在库里，把它加载回来（恢复进度但不自动播放）
 *
 * 列表顺序只有一个来源：`visibleEntries()` 产出的混合行。播放队列也由它派生，
 * 这样「双击哪首就放哪首」在分组视图下同样成立。
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDuration } from '../core/format.js';
import { TrackTable } from './TrackTable.js';
import { Sidebar } from './Sidebar.js';
import { Drawer, PlayerBar } from './PlayerBar.js';
import { MiniLyric } from './LyricsPanel.js';
import {
  diagnoseTrack,
  entryTracks,
  readLiveProgress,
  useAppStore,
  visibleEntries,
} from './store.js';
import type { LibraryView } from './store.js';
import { CloseIcon, FolderIcon, MusicIcon, RefreshIcon, SearchIcon, WarnIcon } from './Icons.js';

const VIEW_TITLE: Record<LibraryView, { title: string; note: string }> = {
  all: { title: '全部曲目', note: '双击任意曲目即从该处开始播放' },
  artist: { title: '艺术家', note: '按艺术家分组，点击分组头可收起' },
  album: { title: '专辑', note: '按专辑分组，点击分组头可收起' },
  recent: { title: '最近添加', note: '按入库时间倒序，最多展示 200 首' },
  played: { title: '最近播放', note: '按播放历史倒序，只保留在库的曲目' },
  diagnostics: {
    title: '问题文件',
    note: '浏览器放不出声、或标签读不出来的文件都在这里',
  },
};

/** 搜索框：输入放组件本地，防抖之后才写进 store（高频输入不该广播到全局）。 */
function SearchBox() {
  const setQuery = useAppStore((state) => state.setQuery);
  const [value, setValue] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(value.trim()), 200);
    return () => clearTimeout(timer);
  }, [value, setQuery]);

  return (
    <label className="search">
      <SearchIcon />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="搜索标题、艺术家、专辑（支持拼音首字母：zjl / qhc）"
        aria-label="搜索曲目"
      />
      {value && (
        <button className="search-clear" onClick={() => setValue('')} title="清空">
          <CloseIcon size={13} />
        </button>
      )}
    </label>
  );
}

function ScanPanel() {
  const scan = useAppStore((state) => state.scan);
  const cancelScan = useAppStore((state) => state.cancelScan);

  if (!scan.active) return null;

  const listing = scan.phase === 'listing';
  const total = scan.total || 0;
  const ratio = listing ? 0 : total > 0 ? Math.min(1, (scan.parsed + scan.reused) / total) : 0;

  return (
    <div className="scan">
      <div className="scan-head">
        <strong>{listing ? '正在遍历文件夹…' : '正在解析元数据…'}</strong>
        <button className="btn btn-quiet" onClick={cancelScan}>
          取消
        </button>
      </div>
      <div className="scan-bar">
        <div className="scan-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <div className="scan-stats">
        <span>已发现 {scan.found}</span>
        {!listing && (
          <>
            <span>已解析 {scan.parsed}</span>
            <span>缓存命中 {scan.reused}</span>
            {scan.failed > 0 && <span className="warn-text">失败 {scan.failed}</span>}
          </>
        )}
      </div>
      {scan.currentPath && <p className="scan-path">{scan.currentPath}</p>}
      <p className="scan-note">扫描只读文件头（默认 16KB），不会把整个文件读进内存。</p>
    </div>
  );
}

/** 问题文件视图顶部的分类小结：先告诉用户"有多少、都是什么问题"。 */
function DiagnosticsSummary() {
  const tracks = useAppStore((state) => state.tracks);

  const counts = useMemo(() => {
    let unsupported = 0;
    let parseError = 0;
    for (const track of tracks) {
      const diagnosis = diagnoseTrack(track);
      if (!diagnosis) continue;
      if (diagnosis.code === 'unsupported') unsupported += 1;
      else parseError += 1;
    }
    return { unsupported, parseError };
  }, [tracks]);

  return (
    <div className="diag">
      <span>
        浏览器无法解码：<strong>{counts.unsupported}</strong> 首
      </span>
      <span>
        标签读取失败：<strong>{counts.parseError}</strong> 首
      </span>
      <span className="muted">
        前者需要换格式（如转成 FLAC / MP3）才能播放；后者不影响播放，只是标题会用文件名。
      </span>
    </div>
  );
}

function EmptyState() {
  const canRestore = useAppStore((state) => state.canRestore);
  const pickDirectory = useAppStore((state) => state.pickDirectory);
  const restoreLibrary = useAppStore((state) => state.restoreLibrary);

  return (
    <div className="empty">
      <span className="empty-mark">
        <MusicIcon size={26} />
      </span>
      <h2>指向你的音乐文件夹</h2>
      <p>曲库全部在本地解析，不上传、不联网。扫描结果会缓存下来，下次打开直接可用。</p>
      <div className="empty-actions">
        <button className="btn btn-primary" onClick={() => void pickDirectory()}>
          <FolderIcon /> 选择音乐文件夹
        </button>
        {canRestore && (
          <button className="btn" onClick={() => void restoreLibrary()}>
            <RefreshIcon /> 恢复上次的曲库
          </button>
        )}
      </div>
      <p className="empty-hint">
        没有 Chrome / Edge？用侧栏的「兼容模式选择文件夹」，但刷新页面后需要重新选择。
      </p>
    </div>
  );
}

function Notices() {
  const notices = useAppStore((state) => state.notices);
  const dismissNotice = useAppStore((state) => state.dismissNotice);

  if (notices.length === 0) return null;

  return (
    <div className="notices">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice-${notice.kind}`}>
          {notice.kind !== 'info' && <WarnIcon size={14} />}
          <span>{notice.message}</span>
          <button className="btn-icon" onClick={() => dismissNotice(notice.id)} title="关闭">
            <CloseIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const ready = useAppStore((state) => state.ready);
  const boot = useAppStore((state) => state.boot);
  const tracks = useAppStore((state) => state.tracks);
  const query = useAppStore((state) => state.query);
  const sortKey = useAppStore((state) => state.sortKey);
  const sortDirection = useAppStore((state) => state.sortDirection);
  const view = useAppStore((state) => state.view);
  const collapsedGroups = useAppStore((state) => state.collapsedGroups);
  const recentPaths = useAppStore((state) => state.recentPaths);
  const scanning = useAppStore((state) => state.scan.active);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 键盘快捷键（产品文档 3.C.9）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const store = useAppStore.getState();

      // 搜索框聚焦在输入框里也允许
      if (event.key === 'f' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.search input')?.focus();
        return;
      }
      if (typing) return;

      const position = readLiveProgress().positionSec;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          void store.togglePlay();
          break;
        case 'ArrowRight':
          event.preventDefault();
          store.seek(position + 5);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          store.seek(Math.max(0, position - 5));
          break;
        case 'ArrowDown':
          event.preventDefault();
          void store.next();
          break;
        case 'ArrowUp':
          event.preventDefault();
          void store.previous();
          break;
        // J / K / L 是播放器的通用键位：后退 10s / 暂停 / 前进 10s
        case 'j':
          store.seek(Math.max(0, position - 10));
          break;
        case 'k':
          void store.togglePlay();
          break;
        case 'l':
          store.seek(position + 10);
          break;
        case '+':
        case '=':
          store.setVolume(store.volume + 0.05);
          break;
        case '-':
        case '_':
          store.setVolume(store.volume - 0.05);
          break;
        case 'm':
          store.toggleMute();
          break;
        case 'q':
          store.toggleQueue();
          break;
        case 'y':
          store.toggleLyrics();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const entries = useMemo(
    () =>
      visibleEntries(tracks, {
        query,
        sortKey,
        sortDirection,
        view,
        recentPaths,
        collapsedGroups,
      }),
    [tracks, query, sortKey, sortDirection, view, recentPaths, collapsedGroups],
  );

  // 队列顺序 = 屏幕上的曲目顺序（分组视图下与排序结果不同）
  const queuePaths = useMemo(() => entryTracks(entries).map((track) => track.path), [entries]);

  const heading = VIEW_TITLE[view];
  const searched = entryTracks(entries);
  const totalSeconds = searched.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);

  return (
    <div className="app">
      <Sidebar />

      <main className="main">
        <header className="main-head">
          <div>
            <h1>{heading.title}</h1>
            <p className="main-note">
              {query
                ? `筛选「${query}」，命中 ${searched.length} 首 · ${formatDuration(totalSeconds)}`
                : `${heading.note} · 共 ${searched.length} 首`}
            </p>
          </div>
          <SearchBox />
        </header>

        <ScanPanel />
        {view === 'diagnostics' && tracks.length > 0 && <DiagnosticsSummary />}

        {!ready ? (
          <div className="loading">正在读取本地曲库缓存…</div>
        ) : tracks.length === 0 && !scanning ? (
          <EmptyState />
        ) : (
          <TrackTable entries={entries} queuePaths={queuePaths} />
        )}

        <footer className="main-foot">
          <span>
            空格 播放/暂停 · ←/→ 快退快进 5s · ↑/↓ 切歌 · J/K/L 后退/暂停/前进 · +/− 音量 ·
            M 静音 · Q 队列 · Y 歌词 · Ctrl+F 搜索
          </span>
          <span>状态自动保存在本地（IndexedDB）</span>
        </footer>
      </main>

      <MiniLyric />
      <Drawer />
      <PlayerBar />
      <Notices />
    </div>
  );
}
