/**
 * 播放引擎：包住一个 `HTMLAudioElement`（技术方案 8.1）。
 *
 * 为什么用 `<audio>` 而不是 Web Audio：
 *  - `URL.createObjectURL(blob)` 直接把本地文件交给 `<audio>`，**不会把整个文件读进内存**
 *  - 拖动进度、缓冲、解码全都不用自己实现
 *  - Web Audio 只在将来要做均衡器 / 频谱 / 无缝衔接时才需要（MVP 范围外）
 *
 * 两个必须做对的地方：
 *  1. 切歌时 revoke 上一个对象 URL，否则每个听过的文件都会钉住一块内存
 *  2. 恢复进度要等 `loadedmetadata`：元数据没到就设 `currentTime` 是无效的
 *
 * 依赖（元素工厂、对象 URL 工厂）都以参数注入，所以这段逻辑能在 Node 里用假元素测：
 * 断言"换一首歌时上一个对象 URL 被 revoke""ended 事件会转成 onEnded 回调"。
 */

export interface LoadRequest {
  /** 曲目身份（path），用于判断当前放的是哪首。 */
  path: string;
  /** 本地文件；给了就创建对象 URL 并由引擎负责 revoke。 */
  blob?: Blob;
  /** 直链（内置样本自检用）；这种 URL 引擎不负责 revoke。 */
  url?: string;
  /** 起始播放位置（秒），用于恢复上次进度。 */
  positionSec?: number;
  autoplay?: boolean;
}

export interface AudioEngineHandlers {
  onTimeUpdate?: (positionSec: number, durationSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
}

export interface AudioEngineDeps {
  createElement?: () => HTMLAudioElement;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export interface AudioEngine {
  readonly element: HTMLAudioElement;
  readonly currentPath: string | undefined;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly paused: boolean;
  load(request: LoadRequest): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  seek(positionSec: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export function createAudioEngine(
  handlers: AudioEngineHandlers = {},
  deps: AudioEngineDeps = {},
): AudioEngine {
  const element = deps.createElement
    ? deps.createElement()
    : (new Audio() as HTMLAudioElement);
  const createObjectURL =
    deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));

  let currentPath: string | undefined;
  /** 只 revoke 自己创建的对象 URL，别去动外部传进来的直链。 */
  let ownedUrl: string | undefined;
  let pendingSeek: number | undefined;

  const onTimeUpdate = (): void => {
    handlers.onTimeUpdate?.(element.currentTime, element.duration);
  };
  const onDurationChange = (): void => {
    handlers.onDurationChange?.(element.duration);
    if (pendingSeek !== undefined) {
      const target = pendingSeek;
      pendingSeek = undefined;
      if (Number.isFinite(target) && target > 0) {
        try {
          element.currentTime = target;
        } catch {
          // 少数实现会在元数据未就绪时抛异常，忽略即可
        }
      }
    }
  };
  const onEnded = (): void => handlers.onEnded?.();
  const onPlay = (): void => handlers.onPlayStateChange?.(true);
  const onPause = (): void => handlers.onPlayStateChange?.(false);
  const onError = (): void => {
    const code = element.error?.message || element.error?.code;
    handlers.onError?.(code ? `播放失败：${code}` : '播放失败');
  };

  element.addEventListener('timeupdate', onTimeUpdate);
  element.addEventListener('durationchange', onDurationChange);
  element.addEventListener('loadedmetadata', onDurationChange);
  element.addEventListener('ended', onEnded);
  element.addEventListener('play', onPlay);
  element.addEventListener('pause', onPause);
  element.addEventListener('error', onError);

  function releaseOwnedUrl(): void {
    if (ownedUrl) {
      revokeObjectURL(ownedUrl);
      ownedUrl = undefined;
    }
  }

  const engine: AudioEngine = {
    element,
    get currentPath() {
      return currentPath;
    },
    get positionSec() {
      return element.currentTime || 0;
    },
    get durationSec() {
      return Number.isFinite(element.duration) ? element.duration : 0;
    },
    get paused() {
      return element.paused;
    },

    async load(request) {
      // 切歌先放掉上一首的对象 URL：不 revoke 的话内存只增不减
      releaseOwnedUrl();
      pendingSeek = request.positionSec;

      if (request.blob) {
        ownedUrl = createObjectURL(request.blob);
        element.src = ownedUrl;
      } else if (request.url) {
        element.src = request.url;
      } else {
        element.removeAttribute?.('src');
        element.src = '';
      }
      currentPath = request.path;

      // 先按加载前的状态回调一次，界面不必等事件
      handlers.onDurationChange?.(engine.durationSec);

      if (request.autoplay) {
        // 必须在用户手势的同一个任务里调用 play()，否则会被自动播放策略拦下
        await engine.play();
      }
    },

    async play() {
      try {
        await element.play();
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error.message : String(error));
      }
    },

    pause() {
      element.pause();
    },

    async toggle() {
      if (element.paused) await engine.play();
      else engine.pause();
    },

    seek(positionSec) {
      if (!Number.isFinite(positionSec)) return;
      try {
        element.currentTime = Math.max(0, positionSec);
      } catch {
        pendingSeek = positionSec;
      }
    },

    setVolume(volume) {
      element.volume = Math.min(1, Math.max(0, volume));
    },

    setMuted(muted) {
      element.muted = muted;
    },

    dispose() {
      element.removeEventListener('timeupdate', onTimeUpdate);
      element.removeEventListener('durationchange', onDurationChange);
      element.removeEventListener('loadedmetadata', onDurationChange);
      element.removeEventListener('ended', onEnded);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('error', onError);
      try {
        element.pause();
      } catch {
        // 忽略
      }
      releaseOwnedUrl();
      currentPath = undefined;
    },
  };

  return engine;
}
