/**
 * MediaSession：系统媒体键与锁屏 / 控制中心展示（技术方案 8.3）。
 *
 * 全部接口都做了存在性判断——Safari / Firefox 的支持情况不一致，
 * 而且 jsdom 里根本没有 `navigator.mediaSession`，缺了它不能影响播放。
 */

export interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler(action: string, handler: ((details?: unknown) => void) | null): void;
  setPositionState?(state?: { duration?: number; playbackRate?: number; position?: number }): void;
}

export interface NowPlayingInfo {
  title: string;
  artist?: string;
  album?: string;
  /** 封面的对象 URL；没有封面时不传。 */
  artworkUrl?: string;
}

export interface MediaSessionHandlers {
  play?(): void;
  pause?(): void;
  stop?(): void;
  previousTrack?(): void;
  nextTrack?(): void;
  seekTo?(time: number): void;
  seekBackward?(offset: number): void;
  seekForward?(offset: number): void;
}

/** 拿不到说明当前环境没有 MediaSession，所有调用都变成空操作。 */
export function getMediaSession(): MediaSessionLike | undefined {
  const session = (globalThis as unknown as { navigator?: { mediaSession?: MediaSessionLike } })
    .navigator?.mediaSession;
  return session ?? undefined;
}

interface MediaMetadataLike {
  title: string;
  artist?: string;
  album?: string;
  artwork?: Array<{ src: string; sizes?: string; type?: string }>;
}

type MediaMetadataCtor = new (init: MediaMetadataLike) => unknown;

export function updateNowPlaying(info: NowPlayingInfo): void {
  const session = getMediaSession();
  if (!session) return;

  const init: MediaMetadataLike = { title: info.title };
  if (info.artist) init.artist = info.artist;
  if (info.album) init.album = info.album;
  // sizes 只是给系统挑图用的提示，写 any 比瞎猜一个尺寸更诚实
  if (info.artworkUrl) init.artwork = [{ src: info.artworkUrl, sizes: 'any' }];

  const ctor = (globalThis as unknown as { MediaMetadata?: MediaMetadataCtor }).MediaMetadata;
  session.metadata = ctor ? new ctor(init) : init;
}

export function setPlaybackState(state: 'none' | 'paused' | 'playing'): void {
  const session = getMediaSession();
  if (!session) return;
  try {
    session.playbackState = state;
  } catch {
    // 个别实现是只读的，忽略
  }
}

/**
 * 让锁屏与控制中心显示正确进度。
 * 时长非法（0 / NaN / Infinity）时直接返回——setPositionState 会对此抛异常。
 */
export function updatePositionState(
  positionSec: number,
  durationSec: number,
  playbackRate = 1,
): void {
  const session = getMediaSession();
  if (!session?.setPositionState) return;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return;
  const position = Math.min(Math.max(positionSec, 0), durationSec);
  if (!Number.isFinite(position)) return;
  try {
    session.setPositionState({ duration: durationSec, playbackRate, position });
  } catch {
    // 参数边界问题不该打断播放
  }
}

export function bindMediaSessionHandlers(handlers: MediaSessionHandlers): void {
  const session = getMediaSession();
  if (!session) return;

  const bind = (action: string, handler?: (details?: never) => void): void => {
    try {
      session.setActionHandler(action, handler ? (handler as (details?: unknown) => void) : null);
    } catch {
      // 不认识的动作名会抛异常，忽略即可
    }
  };

  bind('play', handlers.play);
  bind('pause', handlers.pause);
  bind('stop', handlers.stop);
  bind('previoustrack', handlers.previousTrack);
  bind('nexttrack', handlers.nextTrack);
  bind('seekbackward', handlers.seekBackward ? () => handlers.seekBackward!(10) : undefined);
  bind('seekforward', handlers.seekForward ? () => handlers.seekForward!(10) : undefined);
  bind(
    'seekto',
    handlers.seekTo
      ? (details?: { seekTime?: number }) => {
          if (typeof details?.seekTime === 'number') handlers.seekTo!(details.seekTime);
        }
      : undefined,
  );
}

export function clearNowPlaying(): void {
  const session = getMediaSession();
  if (!session) return;
  session.metadata = null;
  setPlaybackState('none');
}
