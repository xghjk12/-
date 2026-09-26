import { describe, expect, it } from 'vitest';
import {
  fixGbkMojibake,
  hasCjk,
  latin1ToBytes,
  looksLikeLatin1Bytes,
} from './tagEncoding.js';
import type { LegacyDecoder } from './tagEncoding.js';

/** `青花瓷` 的 GBK 字节 `C7 E0 BB A8 B4 C9` 被 latin1 逐字节解码后的乱码。 */
const GARBLED_QINGHUA = String.fromCharCode(0xc7, 0xe0, 0xbb, 0xa8, 0xb4, 0xc9);

/** Node 自带完整 ICU 时才有 gbk；缺失时真实解码那一条优雅跳过。 */
function hasBuiltinGbk(): boolean {
  try {
    new TextDecoder('gbk');
    return true;
  } catch {
    return false;
  }
}

const gbkAvailable = hasBuiltinGbk();

/** 构造一个不依赖具体字节的注射解码器。 */
function stubDecoder(result: string | undefined): LegacyDecoder {
  return () => result;
}

describe('looksLikeLatin1Bytes', () => {
  it('识别"整串被 latin1 解码"的形态', () => {
    expect(looksLikeLatin1Bytes(GARBLED_QINGHUA)).toBe(true);
    expect(looksLikeLatin1Bytes(String.fromCharCode(0xb3, 0xc2, 0xe5))).toBe(true);
  });

  it('单个高位字符不够，避免误伤合法的 latin1 文本', () => {
    expect(looksLikeLatin1Bytes('Björk')).toBe(false);
    expect(looksLikeLatin1Bytes('Café')).toBe(false);
    expect(looksLikeLatin1Bytes('é')).toBe(false);
  });

  it('空串与纯 ASCII 不算', () => {
    expect(looksLikeLatin1Bytes('')).toBe(false);
    expect(looksLikeLatin1Bytes('Track 01')).toBe(false);
  });

  it('已经含汉字或正常 UTF-8 文本不算', () => {
    expect(looksLikeLatin1Bytes('青花瓷')).toBe(false);
    expect(looksLikeLatin1Bytes('Björk 青花瓷')).toBe(false);
  });

  it('高位字符只占非 ASCII 的一小部分时不算（整串本来就是正常解码的）', () => {
    // ĀāĂ 与希腊字母都在 U+00FF 以上：高位字节只占非 ASCII 的 6/14。
    expect(looksLikeLatin1Bytes(`\u0100\u0101\u0102 \u03b1\u03b2\u03b3\u03b4\u03b5 ${GARBLED_QINGHUA}`)).toBe(
      false,
    );
  });

  it('控制字符说明不是整串 latin1 解码的结果', () => {
    expect(looksLikeLatin1Bytes(String.fromCharCode(0xc7, 0xe0, 0x07, 0x1b, 0x02))).toBe(false);
  });
});

describe('latin1ToBytes', () => {
  it('每个码位取低 8 位', () => {
    expect(Array.from(latin1ToBytes('\u0000\u007f\u0080\u00ff'))).toEqual([0x00, 0x7f, 0x80, 0xff]);
  });

  it('码位大于 0xFF 时取低 8 位', () => {
    // U+0100 -> 0x00（Ā）、U+0131 -> 0x31（ı）、U+4E2D -> 0x2D（中）、U+FFFD -> 0xFD
    expect(Array.from(latin1ToBytes('\u0100\u0131\u4e2d\ufffd'))).toEqual([0x00, 0x31, 0x2d, 0xfd]);
  });

  it('空串得到空字节数组', () => {
    expect(latin1ToBytes('').length).toBe(0);
  });

  it('与乱码字符串一一对应', () => {
    expect(Array.from(latin1ToBytes(GARBLED_QINGHUA))).toEqual([0xc7, 0xe0, 0xbb, 0xa8, 0xb4, 0xc9]);
  });
});

describe('hasCjk', () => {
  it('基本区与扩展 A 都算汉字', () => {
    expect(hasCjk('青花瓷')).toBe(true);
    expect(hasCjk('中')).toBe(true);
    expect(hasCjk('\u3400')).toBe(true);
    expect(hasCjk('\u4dbf')).toBe(true);
    expect(hasCjk('a青')).toBe(true);
  });

  it('拉丁字母、日文假名、标点、扩展 B 之外的补充平面不算', () => {
    expect(hasCjk('Björk')).toBe(false);
    expect(hasCjk('')).toBe(false);
    expect(hasCjk('あいう')).toBe(false);
    expect(hasCjk('，。！')).toBe(false);
    expect(hasCjk('𠀀')).toBe(false);
  });
});

describe('fixGbkMojibake / 内置解码器', () => {
  it.skipIf(!gbkAvailable)('真实 GBK 字节序列能被修正', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA)).toBe('青花瓷');
  });

  it.skipIf(!gbkAvailable)('真正含汉字的字符串不会被内置解码器改坏', () => {
    // 汉字若被当成"字节"喂给 GBK，只会解出乱码，所以 looksLikeLatin1Bytes 必须先拦下来。
    for (const text of ['青花瓷', '周杰伦 - 青花瓷', '2001太空漫游']) {
      expect(fixGbkMojibake(text)).toBe(text);
    }
  });

  it.skipIf(!gbkAvailable)('合法的 latin1 文本经内置解码器也不会被改坏', () => {
    for (const text of ['Björk', 'Café', 'Motörhead - Ace of Spades']) {
      expect(fixGbkMojibake(text)).toBe(text);
    }
  });

  it('内置解码器不可用时原样返回', () => {
    if (gbkAvailable) return;
    expect(fixGbkMojibake(GARBLED_QINGHUA)).toBe(GARBLED_QINGHUA);
  });

  it('正常 UTF-8 中文不被改动', () => {
    expect(fixGbkMojibake('青花瓷')).toBe('青花瓷');
  });

  it('合法的 latin1 文本与纯 ASCII 不被误改', () => {
    expect(fixGbkMojibake('Björk')).toBe('Björk');
    expect(fixGbkMojibake('Café')).toBe('Café');
    expect(fixGbkMojibake('Track 01 - Hello')).toBe('Track 01 - Hello');
  });

  it('空串与 undefined 原样返回', () => {
    expect(fixGbkMojibake('')).toBe('');
    expect(fixGbkMojibake(undefined)).toBeUndefined();
  });
});

describe('fixGbkMojibake / 注入解码器', () => {
  it('解出替换字符时放弃修正', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder('\ufffd'))).toBe(GARBLED_QINGHUA);
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder('中文\ufffd'))).toBe(GARBLED_QINGHUA);
  });

  it('解出控制字符时放弃修正', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder('中\u0007文'))).toBe(GARBLED_QINGHUA);
  });

  it('结果不含 CJK 时放弃修正', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder('OK'))).toBe(GARBLED_QINGHUA);
  });

  it('结果含 CJK 且干净时采用注入结果', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder('中文'))).toBe('中文');
  });

  it('结果与输入相同时原样返回', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder(GARBLED_QINGHUA))).toBe(GARBLED_QINGHUA);
  });

  it('解码器返回 undefined 时原样返回', () => {
    expect(fixGbkMojibake(GARBLED_QINGHUA, stubDecoder(undefined))).toBe(GARBLED_QINGHUA);
  });

  it('解码器抛异常时不崩溃、原样返回', () => {
    const throwing: LegacyDecoder = () => {
      throw new Error('unsupported encoding');
    };
    expect(() => fixGbkMojibake(GARBLED_QINGHUA, throwing)).not.toThrow();
    expect(fixGbkMojibake(GARBLED_QINGHUA, throwing)).toBe(GARBLED_QINGHUA);
  });

  it('解码器不可用（返回 undefined/抛异常）时不调用内置回退', () => {
    expect(fixGbkMojibake('Björk', stubDecoder('中文'))).toBe('Björk');
  });
});
