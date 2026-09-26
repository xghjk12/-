/**
 * 侧栏：曲库入口、视图切换、曲库统计。
 *
 * 「一键恢复曲库」是这里最重要的交互（产品文档 5.4 / 技术方案 11）：
 * 浏览器不给全自动加载，句柄持久化之后仍然需要一次用户点击来重新授权，
 * 所以设计成显式的「恢复曲库」按钮，而不是假装曲库还在。
 *
 * 视图计数由 `viewCounts()` 统一算（纯函数，有单测）：艺术家/专辑给的是**分组数**，
 * 与列表里能看到的分组头数量一致，不是曲目数。
 */
import { useRef } from 'react';
import { formatDuration } from '../core/format.js';
import { libraryStats, useAppStore, viewCounts } from './store.js';
import type { LibraryView } from './store.js';
import { FolderIcon, MusicIcon, RefreshIcon, WarnIcon } from './Icons.js';

const VIEWS: Array<{ key: LibraryView; label: string; hint: string }> = [
  { key: 'all', label: '全部曲目', hint: '平铺列表' },
  { key: 'artist', label: '艺术家', hint: '按艺术家分组' },
  { key: 'album', label: '专辑', hint: '按专辑分组' },
  { key: 'recent', label: '最近添加', hint: '按入库时间倒序' },
  { key: 'played', label: '最近播放', hint: '按播放历史倒序' },
  { key: 'diagnostics', label: '问题文件', hint: '放不出声或读不出标签' },
];

export function Sidebar() {
  const tracks = useAppStore((state) => state.tracks);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const rootName = useAppStore((state) => state.rootName);
  const canRestore = useAppStore((state) => state.canRestore);
  const hasSource = useAppStore((state) => state.hasSource);
  const persistent = useAppStore((state) => state.persistent);
  const scanning = useAppStore((state) => state.scan.active);
  const recentPaths = useAppStore((state) => state.recentPaths);
  const drawer = useAppStore((state) => state.drawer);
  const toggleLyrics = useAppStore((state) => state.toggleLyrics);

  const pickDirectory = useAppStore((state) => state.pickDirectory);
  const restoreLibrary = useAppStore((state) => state.restoreLibrary);
  const useFileList = useAppStore((state) => state.useFileList);
  const clearLibrary = useAppStore((state) => state.clearLibrary);

  const inputRef = useRef<HTMLInputElement>(null);
  const stats = libraryStats(tracks);
  const counts = viewCounts(tracks, recentPaths);

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <MusicIcon size={18} />
        </span>
        <span>
          <strong>轻音播放</strong>
          <em>本地音乐 · 零上传</em>
        </span>
      </div>

      <div className="sidebar-actions">
        <button className="btn btn-primary" onClick={() => void pickDirectory()} disabled={scanning}>
          <FolderIcon /> 选择音乐文件夹
        </button>
        {canRestore && !hasSource && (
          <button className="btn" onClick={() => void restoreLibrary()} disabled={scanning}>
            <RefreshIcon /> 恢复曲库（需一次授权）
          </button>
        )}
        <button className="btn btn-quiet" onClick={() => inputRef.current?.click()} disabled={scanning}>
          兼容模式选择文件夹
        </button>
        <input
          ref={inputRef}
          type="file"
          // @ts-expect-error webkitdirectory 不在标准 DOM 类型里，但 Chromium / Firefox 都支持
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) void useFileList(files);
            event.target.value = '';
          }}
        />
      </div>

      <div className="sidebar-source">
        <dt>当前曲库</dt>
        <dd>{hasSource ? rootName || '已选择文件夹' : canRestore ? '等待恢复授权' : '尚未选择'}</dd>
        {stats.total > 0 && (
          <dd className="muted">
            {stats.total} 首曲目 · {formatDuration(stats.durationSec)}
          </dd>
        )}
      </div>

      <nav className="sidebar-nav">
        {VIEWS.map((item) => (
          <button
            key={item.key}
            className={`nav-item${view === item.key ? ' nav-active' : ''}`}
            onClick={() => setView(item.key)}
            title={item.hint}
          >
            <span>{item.label}</span>
            <span className="nav-count">{counts[item.key]}</span>
          </button>
        ))}
        {/*
          歌词单独一项：它不是"视图"（不改变列表），而是打开右侧面板。
          放在这里是因为抽屉里的标签页与播放条上的图标都不够显眼——
          真实使用反馈就是"没找到歌词的入口"。
        */}
        <button
          className={`nav-item${drawer === 'lyrics' ? ' nav-active' : ''}`}
          onClick={toggleLyrics}
          title="打开歌词面板（也可以按 Y）"
        >
          <span>歌词</span>
          <span className="nav-count">{drawer === 'lyrics' ? '打开' : '→'}</span>
        </button>
      </nav>

      <div className="sidebar-foot">
        {stats.total > 0 ? (
          <>
            <p>
              已缓存 {stats.total} 首曲目的元数据
              <br />
              共 {stats.albums} 张专辑 · {stats.artists} 位艺术家
            </p>
            {counts.diagnostics > 0 && (
              <p className="warn-text">
                <WarnIcon size={13} /> {counts.diagnostics} 首需要留意
              </p>
            )}
          </>
        ) : (
          <p>指向你的音乐文件夹即可开始，所有解析都在本地完成。</p>
        )}
        {!persistent && <p className="warn-text">当前浏览器禁用了本地存储，刷新后需要重新扫描。</p>}
        {stats.total > 0 && (
          <button className="btn btn-quiet" onClick={() => void clearLibrary()}>
            清空曲库缓存
          </button>
        )}
      </div>
    </aside>
  );
}
