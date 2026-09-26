import { describe, expect, it } from 'vitest';
import {
  baseName,
  cacheKey,
  guessTitle,
  isCacheHit,
  joinRelativePath,
  stripExtension,
} from './library.js';

describe('cacheKey', () => {
  it('路径、大小、修改时间任一变化都会换键', () => {
    const base = { path: 'a/b.mp3', size: 100, lastModified: 1000 };
    const key = cacheKey(base);
    expect(cacheKey({ ...base })).toBe(key);
    expect(cacheKey({ ...base, path: 'a/c.mp3' })).not.toBe(key);
    expect(cacheKey({ ...base, size: 101 })).not.toBe(key);
    expect(cacheKey({ ...base, lastModified: 1001 })).not.toBe(key);
  });

  it('用 NUL 分隔，路径里含分隔符也不会撞键', () => {
    const a = cacheKey({ path: 'x\u00001', size: 2, lastModified: 3 });
    const b = cacheKey({ path: 'x', size: 1, lastModified: 2 });
    expect(a).not.toBe(b);
  });
});

describe('isCacheHit', () => {
  const current = { path: 'a/b.mp3', size: 100, lastModified: 1000 };

  it('三要素全等才命中', () => {
    expect(isCacheHit({ ...current }, current)).toBe(true);
    expect(isCacheHit({ ...current, size: 101 }, current)).toBe(false);
    expect(isCacheHit(undefined, current)).toBe(false);
  });
});

describe('joinRelativePath', () => {
  it('统一成 posix 分隔符', () => {
    expect(joinRelativePath('专辑', 'a.flac')).toBe('专辑/a.flac');
    expect(joinRelativePath('a\\b', 'c.mp3')).toBe('a/b/c.mp3');
    expect(joinRelativePath('', 'a.flac')).toBe('a.flac');
    expect(joinRelativePath('a', '', 'b.flac')).toBe('a/b.flac');
  });

  it('折叠重复分隔符', () => {
    expect(joinRelativePath('a/', '/b.flac')).toBe('a/b.flac');
  });
});

describe('baseName / stripExtension', () => {
  it('处理两种分隔符', () => {
    expect(baseName('a/b/c.mp3')).toBe('c.mp3');
    expect(baseName('a\\b\\c.mp3')).toBe('c.mp3');
    expect(baseName('c.mp3')).toBe('c.mp3');
  });

  it('只去掉最后一个扩展名', () => {
    expect(stripExtension('a/b.tar.gz')).toBe('b.tar');
    expect(stripExtension('青花瓷.flac')).toBe('青花瓷');
    expect(stripExtension('.gitignore')).toBe('.gitignore');
  });
});

describe('guessTitle', () => {
  it('去掉扩展名', () => {
    expect(guessTitle('青花瓷.flac')).toBe('青花瓷');
  });

  it('去掉常见音轨号前缀', () => {
    expect(guessTitle('01 - 青花瓷.mp3')).toBe('青花瓷');
    expect(guessTitle('01.青花瓷.mp3')).toBe('青花瓷');
    expect(guessTitle('1_青花瓷.mp3')).toBe('青花瓷');
    expect(guessTitle('007 · 青花瓷.mp3')).toBe('青花瓷');
  });

  it('不误伤以数字开头的正常标题', () => {
    expect(guessTitle('1989.flac')).toBe('1989');
    expect(guessTitle('2001太空漫游.flac')).toBe('2001太空漫游');
  });

  it('无法提取时退回原名', () => {
    expect(guessTitle('.gitignore')).toBe('.gitignore');
  });
});
