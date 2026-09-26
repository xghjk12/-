/**
 * 浏览器侧曲库来源（M0 冒烟用，M1 会正式并入 src/platform）。
 *
 * 产品文档 3.A.1 要求两条路统一成 MusicSource：
 *  - 主路：`showDirectoryPicker()`（Chromium），句柄可持久化
 *  - 回退路：`<input webkitdirectory>`，刷新即失效
 *
 * 这里刻意不扩充全局类型：TS 的 DOM lib 对 File System Access API 覆盖并不完整，
 * 而 `declare global` 一旦与内置声明冲突就会编译失败，所以改成从 globalThis 上取。
 *
 * 注意：这段代码无法在 CI 里自动验证（需要真实浏览器与用户手势），
 * 只能通过 `pnpm build:m0` 打开页面手动确认。
 */
import { blobByteSource } from '../src/platform/byteSource.js';
import type { ByteSource } from '../src/platform/byteSource.js';
import type { AudioFileRef, MusicSource } from '../src/platform/musicSource.js';
import { isAudioFileName } from '../src/core/audioFormats.js';
import { joinRelativePath } from '../src/core/library.js';

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
}

export type DirectoryPicker = (options?: {
  mode?: 'read' | 'readwrite';
}) => Promise<DirectoryHandleLike>;

/** 拿不到说明当前浏览器不支持 File System Access API，需要走回退路。 */
export function getDirectoryPicker(): DirectoryPicker | undefined {
  return (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
}

/** 用已列出的 File 对象支撑 open()，避免再次按路径回溯目录树。 */
function sourceFromFiles(rootName: string, files: Map<string, File>): MusicSource {
  return {
    rootName,
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
  };
}

/** 主路：递归遍历目录句柄。 */
export async function collectFromDirectoryHandle(
  handle: DirectoryHandleLike,
  onProgress?: (found: number) => void,
): Promise<MusicSource> {
  const files = new Map<string, File>();

  async function walk(current: DirectoryHandleLike, relativeDir: string): Promise<void> {
    for await (const entry of current.values()) {
      const relativePath = joinRelativePath(relativeDir, entry.name);
      if (entry.kind === 'directory') {
        await walk(entry as DirectoryHandleLike, relativePath);
        continue;
      }
      if (!isAudioFileName(entry.name)) continue;
      files.set(relativePath, await (entry as FileHandleLike).getFile());
      onProgress?.(files.size);
    }
  }

  await walk(handle, '');
  return sourceFromFiles(handle.name, files);
}

/** 回退路：`<input webkitdirectory>` 给出的 FileList，用 webkitRelativePath 作为相对路径。 */
export function sourceFromFileList(fileList: FileList): MusicSource {
  const files = new Map<string, File>();
  for (const file of Array.from(fileList)) {
    const relativePath = joinRelativePath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    );
    if (isAudioFileName(relativePath)) files.set(relativePath, file);
  }
  const rootName =
    [...files.keys()][0]?.split('/')[0] ?? '已选择的文件夹';
  return sourceFromFiles(rootName, files);
}
