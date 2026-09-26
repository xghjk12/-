/**
 * Node 侧的 MusicSource 实现：递归遍历真实目录。
 *
 * 用途是验证「目录递归遍历 + 音频文件筛选 + 相对路径生成」这套逻辑，
 * 浏览器实现会复用同样的 core 层判定（`isAudioFileName` / `joinRelativePath`）。
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isAudioFileName } from '../core/audioFormats.js';
import { joinRelativePath } from '../core/library.js';
import { nodeFileSource } from './nodeFileSource.js';
import type { AudioFileRef, MusicSource } from './musicSource.js';

export function nodeMusicSource(rootDir: string): MusicSource {
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
          if (!entry.isFile() || !isAudioFileName(entry.name)) continue;

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
  };
}
