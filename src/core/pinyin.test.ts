/**
 * 拼音首字母的测试。
 *
 * 声母表本身是脚本生成的（`scripts/make-pinyin-initials.mjs` 里已经抽查过一轮），
 * 这里锁的是**运行时行为**：单字查询、变体展开、非汉字与生僻字的处理，
 * 以及几条已知限制——免得以后有人以为"已经支持全拼了"。
 */
import { describe, expect, it } from 'vitest';
import { hasChinese, initialOf, pinyinInitials, pinyinInitialsVariants } from './pinyin.js';
import { PINYIN_TABLE_CHARS, PINYIN_TABLE_INITIALS } from './pinyinTable.js';

describe('声母表本身', () => {
  it('两个字串等长（逐位对应）', () => {
    expect(PINYIN_TABLE_CHARS.length).toBe(PINYIN_TABLE_INITIALS.length);
  });

  it('覆盖足够多的常用字', () => {
    const mapped = [...PINYIN_TABLE_INITIALS].filter((value) => value !== ' ').length;
    expect(mapped).toBeGreaterThan(3000);
  });

  it('声母只出现合法字母（没有 i / u / v 开头的音节）', () => {
    const letters = new Set([...PINYIN_TABLE_INITIALS].filter((value) => value !== ' '));
    for (const letter of letters) {
      expect('abcdefghjklmnopqrstwxyz', letter).toContain(letter);
    }
  });
});

describe('initialOf', () => {
  it('给出常用字的声母', () => {
    expect(initialOf('青')).toBe('q');
    expect(initialOf('花')).toBe('h');
    expect(initialOf('瓷')).toBe('c');
    expect(initialOf('周')).toBe('z');
    expect(initialOf('蓝')).toBe('l');
    expect(initialOf('我')).toBe('w');
  });

  it('非汉字与二级字区的生僻字没有声母', () => {
    expect(initialOf('A')).toBeUndefined();
    expect(initialOf('1')).toBeUndefined();
    expect(initialOf('，')).toBeUndefined();
    // 「盹」是 GB2312 二级字区的字，表里没有它——这是已知限制
    expect(initialOf('盹')).toBeUndefined();
  });
});

describe('pinyinInitials', () => {
  it('整词转首字母', () => {
    expect(pinyinInitials('青花瓷')).toBe('qhc');
    expect(pinyinInitials('周杰伦')).toBe('zjl');
    expect(pinyinInitials('我很忙')).toBe('whm');
    expect(pinyinInitials('林间清响')).toBe('ljqx');
  });

  it('混合文本里只有汉字贡献字母', () => {
    expect(pinyinInitials('周杰伦 Jay')).toBe('zjl');
    expect(pinyinInitials('Duvet')).toBe('');
    expect(pinyinInitials('第2首')).toBe('ds');
  });

  it('空输入返回空串', () => {
    expect(pinyinInitials('')).toBe('');
    expect(pinyinInitials(undefined)).toBe('');
  });

  it('生僻字跳过而不是中断', () => {
    // 「盹」表里没有，只出「打」的 d
    expect(pinyinInitials('打盹')).toBe('d');
  });
});

describe('pinyinInitialsVariants：多音字变体', () => {
  it('没有多音字时只有一个变体', () => {
    expect(pinyinInitialsVariants('青花瓷')).toEqual(['qhc']);
  });

  it('声母不同的多音字会给出两个变体', () => {
    // 「乐」表里按 lè 记作 l，变体表补上 yuè 的 y
    const variants = pinyinInitialsVariants('乐队');
    expect(variants).toContain('ld');
    expect(variants).toContain('yd');
  });

  it('单字多音字本身就有两个变体', () => {
    expect(pinyinInitialsVariants('长')).toEqual(['c', 'z']);
  });

  it('两个歧义字展开成四种组合，且不超过上限', () => {
    const variants = pinyinInitialsVariants('长重');
    expect(variants).toEqual(['cz', 'cc', 'zz', 'zc']);
  });

  it('歧义字超过两个时只保留主读音，避免组合爆炸', () => {
    expect(pinyinInitialsVariants('长乐重')).toEqual(['clz']);
  });

  it('空输入返回空数组；纯拉丁文本没有变体', () => {
    expect(pinyinInitialsVariants('')).toEqual([]);
    expect(pinyinInitialsVariants('Duvet')).toEqual([]);
  });
});

describe('hasChinese', () => {
  it('识别汉字与扩展 A 区', () => {
    expect(hasChinese('青花瓷')).toBe(true);
    expect(hasChinese('周杰伦 Jay')).toBe(true);
    expect(hasChinese('㐀')).toBe(true);
  });

  it('非中文返回 false', () => {
    expect(hasChinese('Duvet')).toBe(false);
    expect(hasChinese('')).toBe(false);
    expect(hasChinese(undefined)).toBe(false);
  });
});
