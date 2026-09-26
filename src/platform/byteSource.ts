/**
 * 字节读取抽象。
 *
 * M0 实测的核心结论是"只读文件头就能拿到标签与时长"（FLAC 的 STREAMINFO 与
 * ID3v2 / Vorbis comment 都在文件开头），因此解析层不直接吃 File / Blob，而是吃这个接口：
 *
 * - 浏览器：`blobByteSource(File)` 走 `Blob.slice`，只把需要的区间读进内存
 * - Node：`nodeFileSource(path)` 走文件句柄，只从磁盘读需要的区间
 * - 测试：假实现可以断言"到底读了哪些区间"，从而锁住"不要读整个文件"这个行为
 */
export interface ByteSource {
  /** 文件名，用于在没有标签时回退出标题。 */
  readonly name: string;
  readonly size: number;
  /** 读取 `[start, end)` 区间。区间会被裁剪到文件范围内。 */
  read(start: number, end: number): Promise<Uint8Array>;
}

/** 从 Blob / File 构造字节源。 */
export function blobByteSource(blob: Blob, name = 'blob'): ByteSource {
  return {
    name,
    size: blob.size,
    async read(start, end) {
      const from = Math.max(0, Math.min(start, blob.size));
      const to = Math.max(from, Math.min(end, blob.size));
      if (to === from) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(from, to).arrayBuffer());
    },
  };
}
