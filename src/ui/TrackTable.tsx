/**
 * 曲目列表：**必须虚拟化**（技术方案 7.1）。
 *
 * 产品文档的库规模假设是"数千首"，3000 个 DOM 行会明显卡顿，所以虚拟化是 M1 的必要项
 * 而不是优化项：只渲染视口内的行（外加少量缓冲）。这里手写了一个最小的窗口化实现
 * （固定行高，几十行代码），避免为单一场景引入依赖。
 *
 * 另外两条纪律也体现在这里：
 *  - 封面按需从 IndexedDB 读，滚出视口 / 组件卸载时释放引用（配合 `coverCache` 的 LRU）
 *  - 行内容不订阅播放进度，进度由 `PlayerBar` 用 rAF 直接改 DOM
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../core/format.js';
import type { Track } from '../core/track.js';
import { useAppStore } from './store.js';
import { getServices } from './services.js';
import { MusicIcon, WarnIcon } from './Icons.js';

const ROW_HEIGHT = 52;
/** 视口上下各多渲染几行，滚动时不会出现空白。 */
const OVERSCAN = 6;

/** 用专辑名散列出一个稳定的颜色，作为"没有封面"时的占位（实测无封面是常态）。 */
function placeholderColor(track: Track): string {
  const seed = track.album || track.artist || track.title;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${hash} 42% 38%)`;
}

function placeholderLetter(track: Track): string {
  const source = track.album || track.title;
  return source.trim().charAt(0) || '♪';
}

/** 封面缩略图：按需加载 + 卸载时释放引用。 */
function CoverThumb({ track }: { track: Track }) {
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!track.hasCover) {
      setUrl(undefined);
      return;
    }
    let alive = true;
    void (async () => {
      const services = await getServices();
      const next = await services.covers.acquire(track.cacheKey, async () => {
        const cover = await services.storage.getCover(track.cacheKey);
        return cover?.data;
      });
      if (!alive) {
        if (next) services.covers.release(track.cacheKey);
        return;
      }
      setUrl(next);
    })();

    return () => {
      alive = false;
      void getServices().then((services) => services.covers.release(track.cacheKey));
    };
  }, [track.cacheKey, track.hasCover]);

  if (url) {
    return <img className="cover" src={url} alt="" loading="lazy" draggable={false} />;
  }
  return (
    <span className="cover cover-placeholder" style={{ background: placeholderColor(track) }}>
      {track.hasCover ? '' : placeholderLetter(track)}
    </span>
  );
}

interface TrackTableProps {
  tracks: Track[];
}

export function TrackTable({ tracks }: TrackTableProps) {
  const selectedPath = useAppStore((state) => state.selectedPath);
  const currentPath = useAppStore((state) => state.queue[state.currentIndex]);
  const sortKey = useAppStore((state) => state.sortKey);
  const sortDirection = useAppStore((state) => state.sortDirection);
  const setSort = useAppStore((state) => state.setSort);
  const select = useAppStore((state) => state.select);
  const playAt = useAppStore((state) => state.playAt);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // 队列 = 当前可见列表：双击哪首，就从那首顺着当前视图顺序往下放
  const paths = useMemo(() => tracks.map((track) => track.path), [tracks]);

  const total = tracks.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const visible = tracks.slice(start, end);

  const sortMark = (key: typeof sortKey): string =>
    sortKey === key ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';

  return (
    <div className="table">
      <div className="table-head">
        <span className="col-index">#</span>
        <span className="col-title sortable" onClick={() => setSort('title')} role="button" tabIndex={-1}>
          标题{sortMark('title')}
        </span>
        <span className="col-artist sortable" onClick={() => setSort('artist')} role="button" tabIndex={-1}>
          艺术家{sortMark('artist')}
        </span>
        <span className="col-album sortable" onClick={() => setSort('album')} role="button" tabIndex={-1}>
          专辑{sortMark('album')}
        </span>
        <span className="col-duration sortable" onClick={() => setSort('duration')} role="button" tabIndex={-1}>
          时长{sortMark('duration')}
        </span>
      </div>

      <div
        className="table-scroll"
        ref={scrollerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="table-spacer" style={{ height: total * ROW_HEIGHT }}>
          <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {visible.map((track, offset) => {
              const index = start + offset;
              const playing = track.path === currentPath;
              const active = track.path === selectedPath;
              const unsupported = track.verdict !== 'decodable';

              return (
                <div
                  key={track.path}
                  className={`row${active ? ' row-active' : ''}${playing ? ' row-playing' : ''}`}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => select(track.path)}
                  onDoubleClick={() => void playAt(paths, index)}
                  title={unsupported ? track.verdictNote : track.path}
                >
                  <span className="col-index">
                    {playing ? <span className="playing-bars" aria-label="正在播放" /> : index + 1}
                  </span>
                  <span className="col-title">
                    <CoverThumb track={track} />
                    <span className="title-text">
                      <span className="title-main">
                        {track.title}
                        {unsupported && (
                          <span className="badge" title={track.verdictNote}>
                            <WarnIcon size={12} /> {track.extension.toUpperCase()}
                          </span>
                        )}
                        {track.parseError && (
                          <span className="badge badge-quiet" title={track.parseError}>
                            标签读取失败
                          </span>
                        )}
                      </span>
                      {track.lossless && <span className="sub">无损</span>}
                    </span>
                  </span>
                  <span className="col-artist">{track.artist ?? '—'}</span>
                  <span className="col-album">{track.album ?? '—'}</span>
                  <span className="col-duration">{track.durationSec ? formatTime(track.durationSec) : '—'}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {total === 0 && (
        <div className="table-empty">
          <MusicIcon size={22} />
          <p>没有符合条件的曲目</p>
        </div>
      )}
    </div>
  );
}
