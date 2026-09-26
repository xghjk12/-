/**
 * 应用外壳：布局、启动、键盘快捷键、扫描进度、空状态与提示。
 *
 * 启动流程（M3 的"打开就有库"）：
 *  1. 从 IndexedDB 读播放状态与缓存的曲目 → 列表立刻可见，完全不碰音频文件
 *  2. 检查有没有持久化的目录句柄 → 有就显示「恢复曲库」（浏览器要求一次点击重新授权）
 *  3. 扫描结束后如果上次播放的曲目还在库里，把它加载回来（恢复进度但不自动播放）
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDuration } from '../core/format.js';
import { TrackTable } from './TrackTable.js';
import { Sidebar } from './Sidebar.js';
import { PlayerBar, QueueDrawer } from './PlayerBar.js';
import { readLiveProgress, useAppStore, visibleTracks } from './store.js';
import type { LibraryView } from './store.js';
import { CloseIcon, FolderIcon, MusicIcon, RefreshIcon, SearchIcon, WarnIcon } from './Icons.js';

const VIEW_TITLE: Record<LibraryView, { title: string; note: string }> = {
  all: { title: '全部曲目', note: '双击任意曲目即从该处开始播放' },
  recent: { title: '最近添加', note: '按入库时间倒序，最多展示 200 首' },
  unsupported: {
    title: '不支持格式',
    note: '这些文件能读出标签，但浏览器无法解码，播放按钮会被跳过',
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
        placeholder="搜索标题、艺术家、专辑"
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
  const ratio = listing
    ? 0
    : total > 0
      ? Math.min(1, (scan.parsed + scan.reused) / total)
      : 0;

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
      <p>
        曲库全部在本地解析，不上传、不联网。扫描结果会缓存下来，下次打开直接可用。
      </p>
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
  const scanning = useAppStore((state) => state.scan.active);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 键盘快捷键：空格播放暂停、方向键快进快退与切歌（产品文档 3.C.9）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      const store = useAppStore.getState();
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
        case 'm':
          store.toggleMute();
          break;
        case 'q':
          store.toggleQueue();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const visible = useMemo(
    () => visibleTracks(tracks, { query, sortKey, sortDirection, view }),
    [tracks, query, sortKey, sortDirection, view],
  );

  const heading = VIEW_TITLE[view];
  const totalSeconds = visible.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);

  return (
    <div className="app">
      <Sidebar />

      <main className="main">
        <header className="main-head">
          <div>
            <h1>{heading.title}</h1>
            <p className="main-note">
              {query
                ? `筛选「${query}」，命中 ${visible.length} 首 · ${formatDuration(totalSeconds)}`
                : `${heading.note} · 共 ${visible.length} 首`}
            </p>
          </div>
          <SearchBox />
        </header>

        <ScanPanel />

        {!ready ? (
          <div className="loading">正在读取本地曲库缓存…</div>
        ) : tracks.length === 0 && !scanning ? (
          <EmptyState />
        ) : (
          <TrackTable tracks={visible} />
        )}

        <footer className="main-foot">
          <span>空格 播放/暂停 · ←/→ 快退快进 5s · ↑/↓ 切歌 · M 静音 · Q 队列</span>
          <span>状态自动保存在本地（IndexedDB）</span>
        </footer>
      </main>

      <QueueDrawer />
      <PlayerBar />
      <Notices />
    </div>
  );
}
