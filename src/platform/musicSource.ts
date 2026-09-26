/**
 * 曲库来源抽象：产品文档 3.A.1 要求把 `showDirectoryPicker()` 与
 * `<input webkitdirectory>` 两条路统一成同一个接口，这里就是那个接口。
 *
 * 浏览器实现属于 M1（依赖 File System Access API，无法在无浏览器环境下验证）；
 * Node 实现（`nodeMusicSource`）用来在测试与命令行冒烟工具里验证同一套遍历/分类逻辑。
 */
import type { ByteSource } from './byteSource.js';

export interface AudioFileRef {
  /** 相对曲库根目录的路径，posix 分隔符，作为缓存键的一部分。 */
  path: string;
  name: string;
  size: number;
  /** 修改时间（毫秒），与 size 一起构成缓存键。 */
  lastModified: number;
}

export interface MusicSource {
  /** 用于界面展示的根目录名。 */
  readonly rootName: string;
  /** 递归列出全部音频文件；onProgress 回调已发现的文件数，用于扫描进度。 */
  listAudioFiles(onProgress?: (found: number) => void): Promise<AudioFileRef[]>;
  /** 打开某个文件用于解析元数据。 */
  open(ref: AudioFileRef): Promise<ByteSource>;
}
