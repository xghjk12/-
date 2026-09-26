/**
 * 歌词文件匹配的测试：表驱动，样本都来自真实音乐库的命名习惯。
 *
 * 重点有两类：
 *  1. 该认领的都要认领（同名 / 去音轨号 / 艺术家前缀 / lyrics 子目录 / 大小写与空白差异）
 *  2. 有歧义时**一律不认领**（同目录两首同名歌、一首歌被两个歌词命中、跨目录不串台）
 */
import { describe, expect, it } from 'vitest';
import {
  isLyricsDir,
  matchLyrics,
  normalizeForMatch,
  stripTrackNumber,
} from './lyricMatch.js';
import type { LyricFileRef, LyricTarget } from './lyricMatch.js';

function target(path: string, title: string, artist?: string): LyricTarget {
  return { path, name: path.split('/').pop() ?? path, title, artist };
}

function lyric(path: string): LyricFileRef {
  return { path, name: path.split('/').pop() ?? path };
}

/** 只关心"谁配上了谁、依据是什么"。 */
function pairs(result: ReturnType<typeof matchLyrics>): string[] {
  return result.assignments.map((item) => `${item.trackPath} ← ${item.lyricPath} (${item.reason})`);
}

describe('normalizeForMatch / stripTrackNumber', () => {
  it('去扩展名、转小写、统一连接符、空白折成 -', () => {
    expect(normalizeForMatch('01 青花瓷.LRC')).toBe('01-青花瓷');
    expect(normalizeForMatch('周杰伦 － 青花瓷.lrc')).toBe('周杰伦-青花瓷');
    expect(normalizeForMatch('周杰伦 – 青花瓷.lrc')).toBe('周杰伦-青花瓷');
    // 空白与连字符的差别被抹平
    expect(normalizeForMatch('周杰伦 青花瓷.lrc')).toBe(normalizeForMatch('周杰伦 - 青花瓷.lrc'));
    expect(normalizeForMatch('Duvet.LRC')).toBe('duvet');
  });

  it('去音轨号只认「数字 + 分隔符」', () => {
    expect(stripTrackNumber('01-青花瓷')).toBe('青花瓷');
    expect(stripTrackNumber('01.青花瓷')).toBe('青花瓷');
    expect(stripTrackNumber('1_青花瓷')).toBe('青花瓷');
    expect(stripTrackNumber('12·青花瓷')).toBe('青花瓷');
    // 标题本身以数字开头时不能误伤（没有分隔符）
    expect(stripTrackNumber('24小时')).toBe('24小时');
    expect(stripTrackNumber('2001太空漫游')).toBe('2001太空漫游');
  });

  it('识别 lyrics 目录', () => {
    expect(isLyricsDir('专辑/lyrics')).toBe(true);
    expect(isLyricsDir('专辑/Lyrics')).toBe(true);
    expect(isLyricsDir('专辑/歌词')).toBe(true);
    expect(isLyricsDir('专辑/CD2')).toBe(false);
    expect(isLyricsDir('')).toBe(false);
  });
});

describe('matchLyrics：该认领的', () => {
  it('同目录同名 → same-name', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/01 青花瓷.lrc'),
    ]);
    expect(pairs(result)).toEqual(['专辑/01 青花瓷.flac ← 专辑/01 青花瓷.lrc (same-name)']);
  });

  it('歌词没有音轨号 → track-number 规则', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/青花瓷.lrc'),
    ]);
    expect(pairs(result)).toEqual(['专辑/01 青花瓷.flac ← 专辑/青花瓷.lrc (track-number)']);
  });

  it('艺术家 - 标题 命名的歌词 → artist-title', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/周杰伦 - 青花瓷.lrc'),
    ]);
    expect(pairs(result)).toEqual(['专辑/01 青花瓷.flac ← 专辑/周杰伦 - 青花瓷.lrc (artist-title)']);
  });

  it('标题 - 艺术家 顺序反过来也能认', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/青花瓷 - 周杰伦.lrc'),
    ]);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.reason).toBe('artist-title');
  });

  it('只有标题、且与文件名对不上 → title-only', () => {
    const result = matchLyrics([target('专辑/track-07.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/青花瓷.lrc'),
    ]);
    expect(result.assignments[0]?.reason).toBe('title-only');
  });

  it('lyrics 子目录里按同样规则认领', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/lyrics/01 青花瓷.lrc'),
    ]);
    expect(result.assignments).toHaveLength(1);
  });

  it('大小写、空白、全角连接符差异都能容忍', () => {
    const result = matchLyrics([target('Album/Duvet.flac', 'Duvet')], [
      lyric('Album/duvet .LRC'),
    ]);
    expect(result.assignments).toHaveLength(1);
  });

  it('同一目录里多首不同曲目各自对上自己的歌词', () => {
    const targets = [
      target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦'),
      target('专辑/02 我很忙.flac', '我很忙', '周杰伦'),
    ];
    const result = matchLyrics(targets, [lyric('专辑/01 青花瓷.lrc'), lyric('专辑/02 我很忙.lrc')]);

    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((item) => item.trackPath)).toEqual([
      '专辑/01 青花瓷.flac',
      '专辑/02 我很忙.flac',
    ]);
  });

  it('根目录下的曲目同样能认领（dir 为空串）', () => {
    const result = matchLyrics([target('a.flac', 'a')], [lyric('a.lrc')]);
    expect(result.assignments).toHaveLength(1);
  });
});

describe('matchLyrics：歧义与不匹配', () => {
  it('同目录两首同名歌 → 不认领，进 ambiguous', () => {
    // 这正是内置样本的情形：同一首歌的 flac 与 mp3
    const result = matchLyrics(
      [target('相册/sample-cn.flac', '青花瓷', '周杰伦'), target('相册/sample-cn.mp3', '青花瓷', '周杰伦')],
      [lyric('相册/sample-cn.lrc')],
    );

    expect(result.assignments).toEqual([]);
    expect(result.ambiguous.map((item) => item.path)).toEqual(['相册/sample-cn.lrc']);
  });

  it('一首歌被两个歌词命中 → 两个都不认领', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/01 青花瓷.lrc'),
      lyric('专辑/周杰伦 - 青花瓷.lrc'),
    ]);

    expect(result.assignments).toEqual([]);
    expect(result.ambiguous).toHaveLength(2);
  });

  it('目录里没有对应曲目 → unmatched', () => {
    const result = matchLyrics([target('专辑/01 青花瓷.flac', '青花瓷', '周杰伦')], [
      lyric('专辑/完全无关的歌.lrc'),
    ]);

    expect(result.assignments).toEqual([]);
    expect(result.unmatched.map((item) => item.path)).toEqual(['专辑/完全无关的歌.lrc']);
  });

  it('不在同一目录就不认领（两张专辑各有一首 01 序曲 不会串台）', () => {
    const targets = [
      target('专辑A/01 序曲.flac', '序曲'),
      target('专辑B/01 序曲.flac', '序曲'),
    ];
    const result = matchLyrics(targets, [lyric('专辑A/01 序曲.lrc'), lyric('专辑B/01 序曲.lrc')]);

    expect(pairs(result)).toEqual([
      '专辑A/01 序曲.flac ← 专辑A/01 序曲.lrc (same-name)',
      '专辑B/01 序曲.flac ← 专辑B/01 序曲.lrc (same-name)',
    ]);
  });

  it('lyrics 子目录只影响它所在的那张专辑', () => {
    const targets = [
      target('专辑A/01 序曲.flac', '序曲'),
      target('专辑B/01 序曲.flac', '序曲'),
    ];
    const result = matchLyrics(targets, [lyric('专辑A/lyrics/01 序曲.lrc')]);

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.trackPath).toBe('专辑A/01 序曲.flac');
  });

  it('没有歌词文件时返回空结果', () => {
    const result = matchLyrics([target('a.flac', 'a')], []);
    expect(result).toEqual({ assignments: [], unmatched: [], ambiguous: [] });
  });

  it('真实曲库形态：文件名与标签完全不同的曲目也能靠文件名认领', () => {
    // 基准测试库就是这样：文件名是「001 曲目 00004.mp3」，标签却是「青花瓷」。
    // 认领必须走文件名（same-name），不能被标签带偏。
    const result = matchLyrics(
      [
        {
          path: '专辑 004/001 曲目 00004.mp3',
          name: '001 曲目 00004.mp3',
          title: '青花瓷',
          artist: '周杰伦',
          album: '我很忙',
        },
      ],
      [{ path: '专辑 004/001 曲目 00004.lrc', name: '001 曲目 00004.lrc' }],
    );

    expect(result.assignments).toEqual([
      {
        trackPath: '专辑 004/001 曲目 00004.mp3',
        lyricPath: '专辑 004/001 曲目 00004.lrc',
        reason: 'same-name',
        score: 100,
      },
    ]);
  });

  it('同一专辑里多首曲目各自的同名歌词都能认领', () => {
    const targets = [
      { path: '专辑 001/001 曲目 00001.mp3', name: '001 曲目 00001.mp3', title: '青花瓷' },
      { path: '专辑 001/002 曲目 00002.mp3', name: '002 曲目 00002.mp3', title: '青花瓷' },
    ];
    const result = matchLyrics(targets, [
      { path: '专辑 001/001 曲目 00001.lrc', name: '001 曲目 00001.lrc' },
      { path: '专辑 001/002 曲目 00002.lrc', name: '002 曲目 00002.lrc' },
    ]);

    expect(result.assignments).toHaveLength(2);
    expect(result.unmatched).toEqual([]);
  });

  it('目录里还混着别的 .lrc 时不影响正确认领', () => {
    const result = matchLyrics(
      [{ path: '专辑 001/001 曲目 00001.mp3', name: '001 曲目 00001.mp3', title: '青花瓷' }],
      [
        { path: '专辑 001/001 曲目 00001.lrc', name: '001 曲目 00001.lrc' },
        { path: '专辑 001/无对应曲目.lrc', name: '无对应曲目.lrc' },
      ],
    );

    expect(result.assignments).toHaveLength(1);
    expect(result.unmatched.map((item) => item.path)).toEqual(['专辑 001/无对应曲目.lrc']);
  });

  it('没有曲目时所有歌词都算 unmatched', () => {
    const result = matchLyrics([], [lyric('a.lrc')]);
    expect(result.assignments).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
  });
});
