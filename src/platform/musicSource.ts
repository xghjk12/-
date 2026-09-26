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
  /**
   * 列出曲库里的歌词文件（`.lrc`）。
   *
   * 做成可选，而且**"不实现"与"返回空数组"含义不同**：歌词同步会用"某个 .lrc 不再出现"
   * 判断用户把它删了并清理缓存，所以不支持歌词的来源必须压根不实现这两个方法，
   * 而不是返回空数组（否则会把已有歌词全清掉）。
   */
  listLyricFiles?(): Promise<LyricFileRef[]>;
  /** 读取歌词文件原始字节（编码判断交给 `core/lyrics.ts` 的 decodeLyrics）。 */
  openLyricBytes?(ref: LyricFileRef): Promise<Uint8Array>;
}

/** 歌词文件引用。比 core 的匹配输入多几个字段，多出来的会被忽略。 */
export interface LyricFileRef {
  path: string;
  name: string;
  size: number;
  lastModified: number;
}
