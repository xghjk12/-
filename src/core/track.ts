/**
 * 曲目模型：core / platform / ui 三层之间的数据契约。纯数据，不含任何行为。
 *
 * 这里刻意把「曲目身份」与「缓存键」分成两个字段（技术方案 5.1）：
 *  - `path` 是身份，播放状态与队列引用它，文件内容变了也不变
 *  - `cacheKey` = 路径 + 大小 + 修改时间，只用于判断元数据缓存是否失效
 *
 * 混用会出 bug：拿缓存键当身份的话，文件一被编辑，「上次播到哪儿」就丢了。
 */
import type { PlaybackVerdict } from './audioFormats.js';

export interface Track {
  /** 曲目身份：相对曲库根目录的 posix 路径。 */
  readonly path: string;
  /** 文件名，用于展示与标题回退。 */
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  /** 元数据缓存键：路径 + 大小 + 修改时间。 */
  readonly cacheKey: string;

  readonly title: string;
  /** 标题来自文件名回退（没有可用的标题标签）时为 true。 */
  readonly titleFromFileName: boolean;
  readonly artist?: string;
  readonly album?: string;
  readonly albumArtist?: string;
  readonly year?: number;
  readonly trackNo?: number;
  readonly durationSec?: number;

  readonly extension: string;
  readonly codec?: string;
  readonly container?: string;
  readonly lossless?: boolean;
  readonly bitrate?: number;
  readonly sampleRate?: number;

  /** 播放判定：`decodable` 能播，`metadata-only` 只能看信息。 */
  readonly verdict: PlaybackVerdict;
  /** 不可播放时给用户看的说明。 */
  readonly verdictNote?: string;

  /**
   * 是否有内嵌封面。封面字节单独存在 IndexedDB 的 `covers` 仓库里，
   * 列表渲染时按需读取（技术方案 5.4），不随曲目对象一起进内存。
   */
  readonly hasCover: boolean;

  readonly parseError?: string;
  /** 入库时间（毫秒），用于「最近添加」视图。 */
  readonly addedAt: number;
}

/** 未解析元数据的占位曲目所属的字段子集，供 core 的排序与检索使用。 */
export type TrackSortKey = 'default' | 'title' | 'artist' | 'album' | 'duration';
export type SortDirection = 'asc' | 'desc';
