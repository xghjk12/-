/**
 * 浏览器侧曲库来源：把产品文档 3.A.1 的两条路统一成 `MusicSource`。
 *
 *  - 主路 `showDirectoryPicker()`（Chromium）：句柄可以结构化克隆进 IndexedDB，
 *    所以下次打开还能一键恢复曲库（仍需用户点一下重新授权，浏览器不给全自动）
 *  - 回退路 `<input webkitdirectory>`：用 `webkitRelativePath` 当相对路径，刷新即失效
 *
 * 这里刻意不扩充全局类型：TS 的 DOM lib 对 File System Access API 覆盖并不完整，
 * 而 `declare global` 一旦与内置声明冲突就会编译失败，所以改成从 globalThis 上取。
 *
 * 这段代码无法在 CI 里自动验证（需要真实浏览器与用户手势），所以它被刻意压得尽可能薄：
 * 除了"遍历目录树"和"读权限"，判定与解析全部复用 core / metadata 的同一套逻辑。
 */
import { isAudioFileName } from '../core/audioFormats.js';
import { joinRelativePath } from '../core/library.js';
import { isLyricFileName } from '../core/lyrics.js';
import { blobByteSource } from './byteSource.js';
import type { ByteSource } from './byteSource.js';
import type { AudioFileRef, LyricFileRef, MusicSource } from './musicSource.js';

/** 目录句柄在 IndexedDB 里用的键。 */
export const MUSIC_SOURCE_ID = 'music-root';

export interface EntryHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}

export interface FileHandleLike extends EntryHandle {
  readonly kind: 'file';
  getFile(): Promise<File>;
}

export interface DirectoryHandleLike extends EntryHandle {
  readonly kind: 'directory';
  values(): AsyncIterableIterator<EntryHandle>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type DirectoryPicker = (options?: {
  mode?: 'read' | 'readwrite';
}) => Promise<DirectoryHandleLike>;

/** 拿不到说明当前浏览器不支持 File System Access API，需要走回退路。 */
export function getDirectoryPicker(): DirectoryPicker | undefined {
  return (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

export function supportsFileSystemAccess(): boolean {
  return getDirectoryPicker() !== undefined;
}

/** 已经授权过就读得到；没有则只能靠用户手势申请。 */
export async function hasReadPermission(handle: DirectoryHandleLike): Promise<boolean> {
  if (!handle.queryPermission) return true;
  try {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 一键恢复曲库用的授权入口：必须在用户手势里调用。
 * 已经在授权状态下会直接返回 true，不会弹窗。
 */
export async function ensureReadPermission(handle: DirectoryHandleLike): Promise<boolean> {
  if (await hasReadPermission(handle)) return true;
  if (!handle.requestPermission) return false;
  try {
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/** 用已列出的 File 对象支撑 open()，避免再次按路径回溯目录树。 */
function sourceFromFiles(
  rootName: string,
  files: Map<string, File>,
  lyricFiles: Map<string, File>,
): BrowserMusicSource {
  return {
    rootName,
    /**
     * 播放用：把原始 File 直接交给 `<audio>`，**不把文件读进内存**（技术方案 8.1）。
     * 元数据解析走 `open()`（区间读取），播放走这里，两条路各取所需。
     */
    getFile(path) {
      return files.get(path);
    },
    async listAudioFiles(onProgress) {
      const refs: AudioFileRef[] = [];
      for (const [relativePath, file] of files) {
        refs.push({
          path: relativePath,
          name: file.name,
          size: file.size,
          lastModified: Math.floor(file.lastModified),
        });
        onProgress?.(refs.length);
      }
      return refs;
    },
    async open(ref): Promise<ByteSource> {
      const file = files.get(ref.path);
      if (!file) throw new Error(`找不到文件：${ref.path}`);
      return blobByteSource(file, ref.name);
    },
    /** 歌词走单独一张表：音频与歌词是两类资源，混在一起会让"没有 .lrc"变得难以判断。 */
    async listLyricFiles() {
      const refs: LyricFileRef[] = [];
      for (const [relativePath, file] of lyricFiles) {
        refs.push({
          path: relativePath,
          name: file.name,
          size: file.size,
          lastModified: Math.floor(file.lastModified),
        });
      }
      return refs;
    },
    async openLyricBytes(ref) {
      const file = lyricFiles.get(ref.path);
      if (!file) throw new Error(`找不到歌词文件：${ref.path}`);
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

/**
 * 浏览器侧曲库来源。
 *
 * 比通用接口多两处能力：拿到原始 `File`（供播放用），以及**必定支持歌词**
 * （`MusicSource` 里那两个方法是可选的，浏览器实现始终提供，所以这里收紧成必选，
 * 调用方不必到处判断）。
 */
export interface BrowserMusicSource extends MusicSource {
  getFile(path: string): File | undefined;
  listLyricFiles(): Promise<LyricFileRef[]>;
  openLyricBytes(ref: LyricFileRef): Promise<Uint8Array>;
}

/** 遍历期间定期让出事件循环，避免大目录把主线程按住。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 主路：递归遍历目录句柄。 */
export async function collectFromDirectoryHandle(
  handle: DirectoryHandleLike,
  onProgress?: (found: number) => void,
): Promise<BrowserMusicSource> {
  const files = new Map<string, File>();
  const lyricFiles = new Map<string, File>();
  let sinceYield = 0;

  async function walk(current: DirectoryHandleLike, relativeDir: string): Promise<void> {
    for await (const entry of current.values()) {
      const relativePath = joinRelativePath(relativeDir, entry.name);
      if (entry.kind === 'directory') {
        await walk(entry as DirectoryHandleLike, relativePath);
        continue;
      }
      // 歌词文件与音频一起收，但记在各自的表里
      if (isLyricFileName(entry.name)) {
        lyricFiles.set(relativePath, await (entry as FileHandleLike).getFile());
        continue;
      }
      if (!isAudioFileName(entry.name)) continue;
      files.set(relativePath, await (entry as FileHandleLike).getFile());
      onProgress?.(files.size);
      sinceYield += 1;
      if (sinceYield >= 200) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
  }

  await walk(handle, '');
  return sourceFromFiles(handle.name, files, lyricFiles);
}

/**
 * 回退路：`<input webkitdirectory>` 给出的 FileList。
 *
 * `webkitRelativePath` 形如 `音乐/专辑/a.flac`，比句柄模式**多一层用户选中的根目录名**。
 * 这里把它剥掉，让两条入口对同一个文件算出同一个相对路径——否则换个入口就会因为缓存键
 * 不同而全量重扫，用户会以为"曲库丢了"。
 */
export function sourceFromFileList(fileList: FileList): BrowserMusicSource {
  const files = new Map<string, File>();
  const lyricFiles = new Map<string, File>();
  let rootName = '';

  for (const file of Array.from(fileList)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const segments = relative ? relative.split('/') : [file.name];
    if (segments.length > 1 && !rootName) rootName = segments[0]!;

    // 去掉根目录段；没有 webkitRelativePath 时退回文件名
    const path = joinRelativePath(segments.slice(1).join('/')) || joinRelativePath(file.name);
    if (isLyricFileName(path)) lyricFiles.set(path, file);
    else if (isAudioFileName(path)) files.set(path, file);
  }

  return sourceFromFiles(rootName || '已选择的文件夹', files, lyricFiles);
}

export interface PickedDirectory {
  source: BrowserMusicSource;
  handle: DirectoryHandleLike;
}

/** 主路入口：弹系统目录选择框并遍历。用户取消时返回 undefined。 */
export async function pickDirectory(
  onProgress?: (found: number) => void,
): Promise<PickedDirectory | undefined> {
  const picker = getDirectoryPicker();
  if (!picker) return undefined;
  const handle = await picker({ mode: 'read' });
  const source = await collectFromDirectoryHandle(handle, onProgress);
  return { source, handle };
}
