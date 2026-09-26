/**
 * 底部播放条 + 播放队列抽屉。
 *
 * 这里有一条必须守住的性能纪律（技术方案 7.2）：**播放进度不进 React state**。
 * 进度条与两个时间标签用 rAF 直接改 DOM，否则每秒数次的状态更新会带着整棵曲目列表重渲染。
 */
import { useEffect, useRef } from 'react';
import { formatTime } from '../core/format.js';
import { getServices } from './services.js';
import { LyricsPanel } from './LyricsPanel.js';
import { MODE_TEXT, readLiveProgress, useAppStore } from './store.js';
import {
  MuteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  VolumeIcon,
  CloseIcon,
  LyricsIcon,
} from './Icons.js';

function ModeIcon({ mode }: { mode: keyof typeof MODE_TEXT }) {
  if (mode === 'shuffle') return <ShuffleIcon />;
  if (mode === 'repeat-one') return <RepeatOneIcon />;
  if (mode === 'repeat-all') return <RepeatIcon />;
  return <span className="mode-text">顺序</span>;
}

/**
 * 进度条：rAF 直接改 DOM，不参与 React 渲染。
 *
 * 拖动时显示**预览时间**而不立刻跳转：指针抬起才真正 seek。
 * 这样来回拖不会让音频反复重新定位（每次 seek 都要等解码器就绪），也符合播放器的通用手感。
 * 预览值放在 ref 里而不是 state：拖动过程中每秒几十次更新，进 state 会带着整棵列表重渲染。
 */
function Progress() {
  const duration = useAppStore((state) => state.durationSec);
  const seek = useAppStore((state) => state.seek);

  const fillRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  /** 拖动中的预览进度；null 表示没在拖。 */
  const previewRef = useRef<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const live = readLiveProgress();
      const total = live.durationSec || duration;
      const preview = previewRef.current;
      const shown = preview ?? live.positionSec;
      const ratio = total > 0 ? Math.min(1, shown / total) : 0;

      if (fillRef.current) fillRef.current.style.width = `${ratio * 100}%`;
      if (positionRef.current) positionRef.current.textContent = formatTime(shown);
      if (durationRef.current) durationRef.current.textContent = total > 0 ? formatTime(total) : '--:--';
      if (bubbleRef.current) {
        bubbleRef.current.textContent = formatTime(shown);
        bubbleRef.current.style.left = `${ratio * 100}%`;
        bubbleRef.current.dataset.visible = preview === null ? 'false' : 'true';
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration]);

  const previewFromEvent = (clientX: number, element: HTMLElement): void => {
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const live = readLiveProgress();
    const total = live.durationSec || duration;
    if (total > 0) previewRef.current = ratio * total;
  };

  const commit = (): void => {
    const preview = previewRef.current;
    previewRef.current = null;
    if (preview !== null) seek(preview);
  };

  return (
    <div className="progress-row">
      <span className="time" ref={positionRef}>
        0:00
      </span>
      <div
        className="progress"
        onPointerDown={(event) => {
          const bar = event.currentTarget;
          bar.setPointerCapture(event.pointerId);
          previewFromEvent(event.clientX, bar);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) previewFromEvent(event.clientX, event.currentTarget);
        }}
        onPointerUp={commit}
        onPointerCancel={commit}
      >
        <div className="progress-fill" ref={fillRef} />
        <div className="progress-bubble" ref={bubbleRef} data-visible="false" />
      </div>
      <span className="time" ref={durationRef}>
        --:--
      </span>
    </div>
  );
}

function CurrentCover() {
  const resumePath = useAppStore((state) => state.resumePath);
  const track = useAppStore((state) => state.tracks.find((item) => item.path === state.resumePath));

  if (!track || track.path !== resumePath) {
    return <span className="cover cover-placeholder player-cover">♪</span>;
  }
  return <PlayerCover cacheKey={track.cacheKey} hasCover={track.hasCover} letter={track.title.charAt(0)} />;
}

function PlayerCover({
  cacheKey,
  hasCover,
  letter,
}: {
  cacheKey: string;
  hasCover: boolean;
  letter: string;
}) {
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!hasCover) return;
    let alive = true;
    void (async () => {
      const services = await getServices();
      const url = await services.covers.acquire(cacheKey, async () => {
        const cover = await services.storage.getCover(cacheKey);
        return cover?.data;
      });
      if (!alive) {
        if (url) services.covers.release(cacheKey);
        return;
      }
      if (url && ref.current) ref.current.src = url;
    })();
    return () => {
      alive = false;
      void getServices().then((services) => services.covers.release(cacheKey));
    };
  }, [cacheKey, hasCover]);

  if (!hasCover) {
    return <span className="cover cover-placeholder player-cover">{letter || '♪'}</span>;
  }
  return <img className="cover player-cover" ref={ref} alt="" draggable={false} />;
}

export function PlayerBar() {
  const current = useAppStore((state) =>
    state.tracks.find((item) => item.path === state.queue[state.currentIndex]),
  );
  const playing = useAppStore((state) => state.playing);
  const mode = useAppStore((state) => state.mode);
  const volume = useAppStore((state) => state.volume);
  const muted = useAppStore((state) => state.muted);

  const togglePlay = useAppStore((state) => state.togglePlay);
  const next = useAppStore((state) => state.next);
  const previous = useAppStore((state) => state.previous);
  const cycleMode = useAppStore((state) => state.cycleMode);
  const setVolume = useAppStore((state) => state.setVolume);
  const toggleMute = useAppStore((state) => state.toggleMute);
  const toggleQueue = useAppStore((state) => state.toggleQueue);
  const toggleLyrics = useAppStore((state) => state.toggleLyrics);
  const drawer = useAppStore((state) => state.drawer);

  return (
    <footer className="player">
      <div className="player-now">
        <CurrentCover />
        <div className="player-meta">
          <span className="player-title">{current?.title ?? '未在播放'}</span>
          <span className="player-sub">
            {current ? [current.artist ?? '未知艺术家', current.album].filter(Boolean).join(' · ') : '双击曲目开始播放'}
          </span>
        </div>
      </div>

      <div className="player-center">
        <div className="player-controls">
          <button className="btn-icon" onClick={cycleMode} title={`播放模式：${MODE_TEXT[mode]}`}>
            <ModeIcon mode={mode} />
          </button>
          <button className="btn-icon" onClick={() => void previous()} title="上一首">
            <PrevIcon />
          </button>
          <button
            className="btn-play"
            onClick={() => void togglePlay()}
            title={playing ? '暂停（空格）' : '播放（空格）'}
          >
            {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
          </button>
          <button className="btn-icon" onClick={() => void next()} title="下一首">
            <NextIcon />
          </button>
          <button
            className={`btn-icon${drawer === 'queue' ? ' btn-on' : ''}`}
            onClick={toggleQueue}
            title="播放队列"
          >
            <QueueIcon />
          </button>
          <button
            className={`btn-icon${drawer === 'lyrics' ? ' btn-on' : ''}`}
            onClick={toggleLyrics}
            title="歌词"
          >
            <LyricsIcon />
          </button>
        </div>
        <Progress />
      </div>

      <div className="player-volume">
        <button className="btn-icon" onClick={toggleMute} title={muted ? '取消静音' : '静音'}>
          {muted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
        </button>
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          aria-label="音量"
        />
      </div>
    </footer>
  );
}

/**
 * 右抽屉：队列与歌词共用一个抽屉，用标签页切换。
 *
 * 这样不必为歌词再占一块版面（窗口宽度有限），也不用改主区布局。
 */
export function Drawer() {
  const drawer = useAppStore((state) => state.drawer);
  const toggleQueue = useAppStore((state) => state.toggleQueue);
  const toggleLyrics = useAppStore((state) => state.toggleLyrics);

  if (drawer === 'none') return null;

  const close = (): void => {
    if (drawer === 'queue') toggleQueue();
    else toggleLyrics();
  };

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <div className="drawer-tabs">
          <button
            className={`drawer-tab${drawer === 'queue' ? ' drawer-tab-active' : ''}`}
            onClick={() => drawer !== 'queue' && toggleQueue()}
          >
            播放队列
          </button>
          <button
            className={`drawer-tab${drawer === 'lyrics' ? ' drawer-tab-active' : ''}`}
            onClick={() => drawer !== 'lyrics' && toggleLyrics()}
          >
            歌词
          </button>
        </div>
        <button className="btn-icon" onClick={close} title="关闭">
          <CloseIcon />
        </button>
      </header>

      {drawer === 'queue' ? <QueueList /> : <LyricsPanel />}
    </aside>
  );
}

function QueueList() {
  const queue = useAppStore((state) => state.queue);
  const currentIndex = useAppStore((state) => state.currentIndex);
  const tracks = useAppStore((state) => state.tracks);
  const jumpToQueue = useAppStore((state) => state.jumpToQueue);
  const removeFromQueue = useAppStore((state) => state.removeFromQueue);
  const clearQueue = useAppStore((state) => state.clearQueue);

  const byPath = new Map(tracks.map((track) => [track.path, track]));

  return (
    <div className="queue">
      <div className="queue-actions">
        <span className="queue-count">{queue.length} 首</span>
        <button className="btn btn-quiet" onClick={clearQueue} disabled={queue.length === 0}>
          清空
        </button>
      </div>
      <div className="queue-list">
        {queue.length === 0 && <p className="queue-empty">队列是空的，双击曲目即可开始播放。</p>}
        {queue.map((path, index) => {
          const track = byPath.get(path);
          return (
            <div
              key={`${path}-${index}`}
              className={`queue-item${index === currentIndex ? ' queue-current' : ''}`}
            >
              <button className="queue-jump" onClick={() => void jumpToQueue(index)}>
                <span className="queue-index">{index + 1}</span>
                <span className="queue-text">
                  <span className="queue-title">{track?.title ?? path}</span>
                  <span className="queue-sub">{track?.artist ?? '—'}</span>
                </span>
              </button>
              <button
                className="btn-icon queue-remove"
                onClick={() => removeFromQueue(index)}
                title="从队列移除"
              >
                <CloseIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
