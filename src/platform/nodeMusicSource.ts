/**
 * Node 侧的 MusicSource 实现：递归遍历真实目录。
 *
 * 用途是验证「目录递归遍历 + 音频文件筛选 + 相对路径生成」这套逻辑，
 * 浏览器实现会复用同样的 core 层判定（`isAudioFileName` / `joinRelativePath`）。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isAudioFileName } from '../core/audioFormats.js';
import { joinRelativePath } from '../core/library.js';
import { isLyricFileName } from '../core/lyrics.js';
import { nodeFileSource } from './nodeFileSource.js';
import type { AudioFileRef, LyricFileRef, MusicSource } from './musicSource.js';

export function nodeMusicSource(rootDir: string): MusicSource {
  /** 音频与歌词分开收集：扫描逻辑要求"不实现歌词"与"没有歌词"含义不同。 */
  const lyricFiles = new Map<string, string>();

  return {
    rootName: path.basename(rootDir),

    async listAudioFiles(onProgress) {
      const found: AudioFileRef[] = [];

      async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
        const entries = await readdir(absoluteDir, { withFileTypes: true });
        for (const entry of entries) {
          const absolute = path.join(absoluteDir, entry.name);
          const relative = joinRelativePath(relativeDir, entry.name);

          if (entry.isDirectory()) {
            await walk(absolute, relative);
            continue;
          }
          if (!entry.isFile()) continue;

          if (isLyricFileName(entry.name)) {
            lyricFiles.set(relative, absolute);
            continue;
          }
          if (!isAudioFileName(entry.name)) continue;

          const info = await stat(absolute);
          found.push({
            path: relative,
            name: entry.name,
            size: info.size,
            lastModified: Math.floor(info.mtimeMs),
          });
          onProgress?.(found.length);
        }
      }

      await walk(rootDir, '');
      return found;
    },

    open(ref) {
      return nodeFileSource(path.join(rootDir, ref.path));
    },

    async listLyricFiles(): Promise<LyricFileRef[]> {
      const refs: LyricFileRef[] = [];
      for (const [relative, absolute] of lyricFiles) {
        const info = await stat(absolute);
        refs.push({
          path: relative,
          name: path.basename(absolute),
          size: info.size,
          lastModified: Math.floor(info.mtimeMs),
        });
      }
      return refs;
    },

    async openLyricBytes(ref) {
      return new Uint8Array(await readFile(path.join(rootDir, ref.path)));
    },
  };
}
