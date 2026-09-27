/**
 * 歌词解析与定位的测试。
 *
 * 这些用例来自真实世界上会遇到的 `.lrc` 形态：一行多时间戳、冒号小数、`[offset:]`、
 * 增强型逐字、干脆没有时间轴的纯文本。解析器必须都能吃下去，且**永不抛异常**。
 */
import { describe, expect, it } from 'vitest';
import {
  buildLyricSearchUrl,
  currentLineIndex,
  decodeLyrics,
  isSafeSearchTemplate,
  lyricSearchKeyword,
  lyricsToText,
  parseLyrics,
} from './lyrics.js';

describe('parseLyrics：标准 LRC', () => {
  it('解析时间戳与文本，按时间升序', () => {
    const lyrics = parseLyrics(['[00:12.50]第二句', '[00:05.00]第一句'].join('\n'));

    expect(lyrics.synced).toBe(true);
    expect(lyrics.lines).toEqual([
      { timeSec: 5, text: '第一句' },
      { timeSec: 12.5, text: '第二句' },
    ]);
  });

  it('一行挂多个时间戳会展开成多行', () => {
    const lyrics = parseLyrics('[00:10.00][01:20.00]同一句歌词');
    expect(lyrics.lines.map((line) => line.timeSec)).toEqual([10, 80]);
    expect(lyrics.lines.every((line) => line.text === '同一句歌词')).toBe(true);
  });

  it('支持 [分:秒] / [分:秒.小数] / [分:秒:小数] 三种写法', () => {
    const lyrics = parseLyrics(
      ['[01:02]整秒', '[01:02.5]一位小数', '[01:02.25]两位小数', '[01:02:25]冒号写法', '[01:02.250]毫秒'].join('\n'),
    );

    // 这条只验"时间戳算得对"，排序另有测试，所以先排一遍再比
    const times = lyrics.lines.map((line) => line.timeSec).sort((a, b) => a - b);
    expect(times).toEqual([62, 62.25, 62.25, 62.25, 62.5]);
  });

  it('空文本的时间戳保留（用来清空当前行）', () => {
    const lyrics = parseLyrics('[00:10.00]有词\n[00:15.00]');
    expect(lyrics.lines[1]).toEqual({ timeSec: 15, text: '' });
  });

  it('中文与空行混排不丢内容', () => {
    const lyrics = parseLyrics('\n[00:01.00]青花瓷\n\n[00:05.00]素胚勾勒出青花\n');
    expect(lyrics.lines.map((line) => line.text)).toEqual(['青花瓷', '素胚勾勒出青花']);
  });
});

describe('parseLyrics：元数据与增强型', () => {
  it('读出 ti / ar / al / by / offset', () => {
    const lyrics = parseLyrics(
      ['[ti:青花瓷]', '[ar:周杰伦]', '[al:我很忙]', '[by:某某]', '[offset:-500]', '[00:01.00]词'].join('\n'),
    );

    expect(lyrics).toMatchObject({
      title: '青花瓷',
      artist: '周杰伦',
      album: '我很忙',
      by: '某某',
      offsetSec: -0.5,
    });
  });

  it('offset 非数字时忽略，不影响其它解析', () => {
    const lyrics = parseLyrics('[offset:abc]\n[00:01.00]词');
    expect(lyrics.offsetSec).toBe(0);
    expect(lyrics.lines).toHaveLength(1);
  });

  it('增强型逐字标签解析进模型，但行文本是干净的', () => {
    const lyrics = parseLyrics('[00:01.00]<00:01.00>青<00:01.50>花<00:02.00>瓷');

    expect(lyrics.lines[0]!.text).toBe('青花瓷');
    expect(lyrics.lines[0]!.words).toEqual([
      { timeSec: 1, text: '青' },
      { timeSec: 1.5, text: '花' },
      { timeSec: 2, text: '瓷' },
    ]);
  });
});

describe('parseLyrics：纯文本与异常输入', () => {
  it('没有时间轴时退化成纯文本', () => {
    const lyrics = parseLyrics('第一行\n第二行\n\n第三行');

    expect(lyrics.synced).toBe(false);
    expect(lyrics.lines).toEqual([]);
    expect(lyrics.plainLines).toEqual(['第一行', '第二行', '第三行']);
  });

  it('空输入与空串不抛异常', () => {
    expect(parseLyrics('')).toMatchObject({ lines: [], plainLines: [], synced: false });
    expect(parseLyrics('\n\n')).toMatchObject({ lines: [], plainLines: [], synced: false });
  });

  it('CRLF 与 BOM 都能处理', () => {
    const lyrics = parseLyrics('\uFEFF[00:01.00]第一句\r\n[00:02.00]第二句\r\n');
    expect(lyrics.lines.map((line) => line.text)).toEqual(['第一句', '第二句']);
  });
});

describe('currentLineIndex', () => {
  const lyrics = parseLyrics('[00:10.00]一\n[00:20.00]二\n[00:30.00]三');

  it('第一句之前返回 -1', () => {
    expect(currentLineIndex(lyrics.lines, 0)).toBe(-1);
    expect(currentLineIndex(lyrics.lines, 9.99)).toBe(-1);
  });

  it('边界上取当前句（含等于）', () => {
    expect(currentLineIndex(lyrics.lines, 10)).toBe(0);
    expect(currentLineIndex(lyrics.lines, 19.99)).toBe(0);
    expect(currentLineIndex(lyrics.lines, 20)).toBe(1);
  });

  it('最后一句之后一直停在最后一句', () => {
    expect(currentLineIndex(lyrics.lines, 999)).toBe(2);
  });

  it('没有同步歌词时返回 -1', () => {
    expect(currentLineIndex(parseLyrics('纯文本').lines, 30)).toBe(-1);
    expect(currentLineIndex([], 30)).toBe(-1);
  });

  it('正偏移表示歌词提前出现', () => {
    // 偏移 +2s：9 秒时应该已经显示 10 秒那句
    expect(currentLineIndex(lyrics.lines, 8.5, 0)).toBe(-1);
    expect(currentLineIndex(lyrics.lines, 8.5, 2)).toBe(0);
    // 负偏移表示歌词延后
    expect(currentLineIndex(lyrics.lines, 10.5, -2)).toBe(-1);
  });
});

describe('lyricsToText', () => {
  it('同步歌词导出成纯文本，丢掉空行时间戳', () => {
    expect(lyricsToText(parseLyrics('[00:01.00]一\n[00:02.00]\n[00:03.00]二'))).toBe('一\n二');
  });

  it('纯文本原样导出', () => {
    expect(lyricsToText(parseLyrics('一\n二'))).toBe('一\n二');
  });
});

describe('decodeLyrics：编码回退', () => {
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('UTF-8 正常解码', () => {
    expect(decodeLyrics(utf8('[00:01.00]青花瓷'))).toBe('[00:01.00]青花瓷');
  });

  it('GBK 字节按 GBK 解出来（老歌词文件最常见的情况）', () => {
    // 「青花瓷」的 GBK 字节：C7 E0 BB A8 B4 C9
    const gbk = new Uint8Array([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xc7, 0xe0, 0xbb, 0xa8, 0xb4, 0xc9]);
    expect(decodeLyrics(gbk)).toBe('[00:01.00]青花瓷');
  });

  it('UTF-8 BOM 被剥掉', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('青花瓷')]);
    expect(decodeLyrics(withBom)).toBe('青花瓷');
  });

  it('UTF-16LE BOM 走对应编码', () => {
    const text = '青花瓷';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[3 + i * 2] = code >> 8;
    }
    expect(decodeLyrics(bytes)).toBe('青花瓷');
  });

  it('空输入返回空串', () => {
    expect(decodeLyrics(new Uint8Array(0))).toBe('');
  });

  it('解码器全部不可用时也不抛异常', () => {
    const failing = () => undefined;
    expect(decodeLyrics(utf8('青花瓷'), failing)).toBe('');
  });

  it('严格 UTF-8 失败才退 GBK（不会把正常 UTF-8 当 GBK）', () => {
    const calls: string[] = [];
    const spy = (_bytes: Uint8Array, label: string): string => {
      calls.push(label);
      return label === 'utf-8' ? '正常' : '乱码';
    };
    expect(decodeLyrics(utf8('正常文本'), spy)).toBe('正常');
    expect(calls).toEqual(['utf-8']);
  });
});

describe('搜索地址模板', () => {
  const track = { title: '青花瓷', artist: '周杰伦', album: '我很忙', trackNo: 1 };

  it('只接受 http / https（模板是用户可编辑的，javascript: 会被拒）', () => {
    expect(isSafeSearchTemplate('https://example.com/search?q={keyword}')).toBe(true);
    expect(isSafeSearchTemplate('http://example.com/?q={keyword}')).toBe(true);
    expect(isSafeSearchTemplate('javascript:alert(1)//{keyword}')).toBe(false);
    expect(isSafeSearchTemplate('data:text/html,{keyword}')).toBe(false);
    expect(isSafeSearchTemplate('file:///c:/{keyword}')).toBe(false);
    expect(isSafeSearchTemplate('')).toBe(false);
    expect(isSafeSearchTemplate('不是地址')).toBe(false);
  });

  it('替换占位符并做 URL 编码', () => {
    const url = buildLyricSearchUrl('https://example.com/s?q={keyword}&t={title}&a={artist}', track);
    expect(url).toBe(
      'https://example.com/s?q=%E5%91%A8%E6%9D%B0%E4%BC%A6%20%E9%9D%92%E8%8A%B1%E7%93%B7&t=%E9%9D%92%E8%8A%B1%E7%93%B7&a=%E5%91%A8%E6%9D%B0%E4%BC%A6',
    );
  });

  it('keyword 是「艺术家 + 标题」', () => {
    expect(lyricSearchKeyword(track)).toBe('周杰伦 青花瓷');
    expect(lyricSearchKeyword({ title: '纯音乐' })).toBe('纯音乐');
  });

  it('缺字段时替换成空串而不是 undefined', () => {
    const url = buildLyricSearchUrl('https://example.com/?q={keyword}&al={album}', { title: '无题' });
    expect(url).toBe('https://example.com/?q=%E6%97%A0%E9%A2%98&al=');
  });

  it('模板为空、没有占位符或不安全时返回 undefined', () => {
    expect(buildLyricSearchUrl('', track)).toBeUndefined();
    expect(buildLyricSearchUrl('https://example.com/search', track)).toBeUndefined();
    expect(buildLyricSearchUrl('javascript:x{title}', track)).toBeUndefined();
  });

  it('不认识的占位符原样保留（方便用户自己排错）', () => {
    expect(buildLyricSearchUrl('https://example.com/?q={keyword}&x={nope}', track)).toBe(
      'https://example.com/?q=%E5%91%A8%E6%9D%B0%E4%BC%A6%20%E9%9D%92%E8%8A%B1%E7%93%B7&x={nope}',
    );
  });
});

/**
 * 这两块都来自真实下载到的歌词（外部工具 + LrcApi 的产出），不是假想用例：
 * 库里 4 首纯音乐的占位行、以及每份歌词开头的署名行。
 */
describe('parseLyrics：纯音乐占位', () => {
  it('只有占位行时判定为纯音乐，且不留下任何歌词行', () => {
    const lyrics = parseLyrics('[00:05.000]纯音乐，请欣赏');
    expect(lyrics.instrumental).toBe(true);
    expect(lyrics.lines).toEqual([]);
    expect(lyrics.plainLines).toEqual([]);
    expect(lyrics.synced).toBe(false);
  });

  it('署名行 + 占位行（最常见的形态）同样判定为纯音乐', () => {
    const lyrics = parseLyrics('[00:00.000] 作曲 : Hiboky\n[99:00.000]纯音乐，请欣赏');
    expect(lyrics.instrumental).toBe(true);
    expect(lyrics.lines).toEqual([]);
  });

  it('几种真实写法都能认出来', () => {
    for (const text of [
      '[00:01.580]纯音乐，请欣赏',
      '[00:05.000]此歌曲为没有填词的纯音乐，请您欣赏',
      '[00:05.000]暂无歌词',
      '[00:05.000]Instrumental',
      '纯音乐，请欣赏',
    ]) {
      expect(parseLyrics(text).instrumental, text).toBe(true);
    }
  });

  it('署名 + 真的歌词不会被误判为纯音乐', () => {
    const lyrics = parseLyrics('[00:00.000] 作词 : Vagary\n[00:23.650]嘲笑谁恃美扬威');
    expect(lyrics.instrumental).toBeUndefined();
    expect(lyrics.lines).toHaveLength(2);
    expect(lyrics.synced).toBe(true);
  });

  it('占位行混在真歌词里时只丢掉占位行', () => {
    const lyrics = parseLyrics(
      '[00:00.000] 作曲 : Someone\n[00:05.000]纯音乐，请欣赏\n[00:10.000]真正的第一句',
    );
    expect(lyrics.instrumental).toBeUndefined();
    expect(lyrics.lines.map((line) => line.text)).toEqual(['作曲 : Someone', '真正的第一句']);
  });

  it('人声念白不会被当成占位（Flower Dance 那种）', () => {
    const lyrics = parseLyrics(
      '[00:00.070]DJ Okawari - Flower Dance\n' +
        '[00:02.670]Composed by：DJ OKAWARI\n' +
        '[00:05.350]They serve the purpose of changing hydrogen into breathable oxygen',
    );
    expect(lyrics.instrumental).toBeUndefined();
    expect(lyrics.lines).toHaveLength(3);
  });
});

describe('parseLyrics：署名行', () => {
  it('常见中英文署名都被标记，普通歌词不会被误标', () => {
    const lyrics = parseLyrics(
      [
        '[00:00.000] 作词 : Vagary',
        '[00:01.000] 作曲 : 银临',
        '[00:02.000]编曲：Someone',
        '[00:03.000]Composed by：DJ OKAWARI',
        '[00:04.000]Lyrics by：Someone',
        '[00:05.000]嘲笑谁恃美扬威',
      ].join('\n'),
    );

    expect(lyrics.lines.map((line) => line.credit)).toEqual([true, true, true, true, true, undefined]);
  });

  it('必须带分隔符，单字「曲」不会误伤正常歌词', () => {
    const lyrics = parseLyrics('[00:00.000]曲终人散');
    expect(lyrics.lines[0]!.credit).toBeUndefined();
  });

  it('署名行仍然保留在 lines 里（只是标记出来，界面负责弱化）', () => {
    const lyrics = parseLyrics('[00:00.000] 作词 : Vagary');
    expect(lyrics.lines).toHaveLength(1);
    expect(lyrics.lines[0]).toMatchObject({ credit: true, text: '作词 : Vagary' });
    // 复制成文本时不该带上署名
    expect(lyricsToText(lyrics)).toBe('作词 : Vagary');
  });
});

describe('parseLyrics：接口返回的纯文本标记', () => {
  it('`[!text]` 前缀会被剥掉，不进入歌词正文', () => {
    const lyrics = parseLyrics('[!text]將一切理想\n[!text]定性為妄想');
    expect(lyrics.instrumental).toBeUndefined();
    expect(lyrics.plainLines).toEqual(['將一切理想', '定性為妄想']);
  });
});
