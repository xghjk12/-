import { describe, expect, it } from 'vitest';
import { classifyAudioFile, extensionOf, isAudioFileName, resolveVerdict } from './audioFormats.js';

describe('extensionOf', () => {
  it('取小写扩展名，兼容两种路径分隔符', () => {
    expect(extensionOf('song.MP3')).toBe('mp3');
    expect(extensionOf('a/b/c.FLAC')).toBe('flac');
    expect(extensionOf('a\\b\\c.Flac')).toBe('flac');
  });

  it('中文文件名与多点文件名', () => {
    expect(extensionOf('青花瓷 - 周杰伦.flac')).toBe('flac');
    expect(extensionOf('01. 青花瓷.mp3')).toBe('mp3');
  });

  it('没有扩展名或以点开头时返回空串', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('a/.gitignore')).toBe('');
  });
});

describe('classifyAudioFile', () => {
  it('flac / mp3 判定为可解码', () => {
    expect(classifyAudioFile('a.flac')).toEqual({ extension: 'flac', verdict: 'decodable' });
    expect(classifyAudioFile('a.mp3')).toEqual({ extension: 'mp3', verdict: 'decodable' });
  });

  it('m4a 标记为需要按 codec 复核（可能是 ALAC）', () => {
    const verdict = classifyAudioFile('a.m4a');
    expect(verdict?.verdict).toBe('decodable');
    expect(verdict?.codecSensitive).toBe(true);
  });

  it('APE / DSD / WavPack 只读信息不可播放，并带用户可读说明', () => {
    for (const name of ['a.ape', 'a.dsf', 'a.dff', 'a.wv', 'a.wma']) {
      const verdict = classifyAudioFile(name);
      expect(verdict?.verdict, name).toBe('metadata-only');
      expect(verdict?.note, name).toBeTruthy();
    }
  });

  it('非音频文件返回 null', () => {
    for (const name of ['cover.jpg', 'notes.txt', 'archive.zip', 'README', 'a.mp4.bak']) {
      expect(classifyAudioFile(name), name).toBeNull();
    }
  });

  it('大小写不敏感', () => {
    expect(classifyAudioFile('A.FLAC')?.verdict).toBe('decodable');
    expect(classifyAudioFile('A.APE')?.verdict).toBe('metadata-only');
  });

  it('isAudioFileName 与判定一致', () => {
    expect(isAudioFileName('a.flac')).toBe(true);
    expect(isAudioFileName('a.ape')).toBe(true);
    expect(isAudioFileName('a.txt')).toBe(false);
  });
});

describe('resolveVerdict', () => {
  it('m4a 里是 ALAC 时降级为 metadata-only', () => {
    const base = classifyAudioFile('a.m4a')!;
    const resolved = resolveVerdict(base, 'ALAC');
    expect(resolved.verdict).toBe('metadata-only');
    expect(resolved.note).toContain('ALAC');
  });

  it('m4a 里是 AAC 时保持可解码', () => {
    const base = classifyAudioFile('a.m4a')!;
    expect(resolveVerdict(base, 'AAC').verdict).toBe('decodable');
  });

  it('不敏感的扩展名不受 codec 影响', () => {
    const base = classifyAudioFile('a.flac')!;
    expect(resolveVerdict(base, 'FLAC')).toBe(base);
  });

  it('没有 codec 信息时保持原判定', () => {
    const base = classifyAudioFile('a.m4a')!;
    expect(resolveVerdict(base, undefined)).toBe(base);
  });
});
