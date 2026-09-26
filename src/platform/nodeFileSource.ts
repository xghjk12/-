/**
 * Node 侧字节源：按区间从磁盘读取，不把整个文件读进内存。
 *
 * 这个文件只给 Node（测试、命令行冒烟工具）用，浏览器侧请用 `blobByteSource`。
 */
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ByteSource } from './byteSource.js';

export async function nodeFileSource(filePath: string): Promise<ByteSource> {
  const info = await stat(filePath);
  return {
    name: basename(filePath),
    size: info.size,
    async read(start, end) {
      const from = Math.max(0, Math.min(start, info.size));
      const to = Math.max(from, Math.min(end, info.size));
      if (to === from) return new Uint8Array(0);
      const handle = await open(filePath, 'r');
      try {
        const buffer = new Uint8Array(to - from);
        await handle.read(buffer, 0, to - from, from);
        return buffer;
      } finally {
        await handle.close();
      }
    },
  };
}
