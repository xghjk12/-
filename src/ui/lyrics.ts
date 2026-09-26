/**
 * 歌词的界面侧读取与缓存。
 *
 * 为什么要单独一层：歌词同时被**两处**用到——右侧歌词面板与播放条上的迷你歌词。
 * 两边各读一次 IndexedDB 显然是浪费，而且写完（导入/粘贴/微调偏移）之后两边都要刷新。
 * 所以这里用一张模块级缓存 + 订阅来做：谁改了歌词就 `invalidateLyrics()`，两边一起重读。
 *
 * 当前行**不放这里**：那是每秒都在变的东西，各组件自己用 rAF 算、只在行号变化时 setState。
 */
import { useEffect, useState } from 'react';
import { decodeLyrics, parseLyrics } from '../core/lyrics.js';
import type { Lyrics } from '../core/lyrics.js';
import type { LyricRecord } from '../platform/storage.js';
import { getServices } from './services.js';

export interface LyricsState {
  loading: boolean;
  record?: LyricRecord;
  lyrics?: Lyrics;
}

interface CacheEntry {
  record?: LyricRecord;
  lyrics: Lyrics;
}

const cache = new Map<string, CacheEntry | null>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 歌词变化后调用：清掉缓存并通知所有正在显示歌词的组件重读。 */
export function invalidateLyrics(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
  emit();
}

async function load(path: string): Promise<CacheEntry | null> {
  const services = await getServices();
  const record = await services.storage.getLyrics(path);
  if (!record) return null;
  return { record, lyrics: parseLyrics(record.text) };
}

/** 读某首曲目的歌词（带缓存与订阅）。 */
export function useLyrics(path: string | undefined): LyricsState {
  const [state, setState] = useState<LyricsState>({ loading: Boolean(path) });
  const [tick, setTick] = useState(version);

  useEffect(() => subscribe(() => setTick((value) => value + 1)), []);

  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }

    const cached = cache.get(path);
    if (cached !== undefined) {
      setState(cached === null ? { loading: false } : { loading: false, ...cached });
      return;
    }

    let alive = true;
    setState({ loading: true });
    void load(path)
      .then((entry) => {
        if (!alive) return;
        cache.set(path, entry);
        setState(entry === null ? { loading: false } : { loading: false, ...entry });
      })
      .catch(() => {
        if (alive) setState({ loading: false });
      });

    return () => {
      alive = false;
    };
  }, [path, tick]);

  return state;
}

/** 歌词的生效偏移 = 文件里 `[offset:]` + 用户微调。 */
export function effectiveOffsetSec(record: LyricRecord | undefined, lyrics: Lyrics | undefined): number {
  return (lyrics?.offsetSec ?? 0) + (record?.userOffsetSec ?? 0);
}

/** 把导入的文件字节解码成歌词文本（编码判断复用 core 的逻辑）。 */
export async function readLyricFile(file: File): Promise<string> {
  return decodeLyrics(new Uint8Array(await file.arrayBuffer()));
}
