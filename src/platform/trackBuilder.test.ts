/**
 * 「文件引用 + 解析结果 → Track」的映射测试。
 *
 * 两个最容易写错的点各有一组用例：
 *  1. 播放判定要复核 codec（`.m4a` 里可能装的是 ALAC，只看扩展名会"显示可播放但放不出声"）
 *  2. 曲目身份 `path` 与缓存键 `cacheKey` 不能混（混了以后文件一被编辑，播放进度就丢）
 */
import { describe, expect, it } from 'vitest';
import { cacheKey } from '../core/library.js';
import type { TrackMetadata } from './metadata.js';
import type { AudioFileRef } from './musicSource.js';
import { buildTrack } from './trackBuilder.js';

const ADDED_AT = 1_700_000_000_000;

function ref(name: string, extra: Partial<AudioFileRef> = {}): AudioFileRef {
  return {
    path: `专辑/${name}`,
    name,
    size: 1024,
    lastModified: 555,
    ...extra,
  };
}

function metadata(extra: Partial<TrackMetadata> = {}): TrackMetadata {
  return {
    title: '标题',
    titleFromFileName: false,
    readStrategy: 'probe',
    bytesRead: 1024,
    ...extra,
  };
}

describe('buildTrack：身份与缓存键', () => {
  it('path 是曲目身份，cacheKey 由路径 + 大小 + 修改时间组成', () => {
    const file = ref('a.flac');
    const track = buildTrack(file, metadata(), ADDED_AT);

    expect(track.path).toBe('专辑/a.flac');
    expect(track.cacheKey).toBe(cacheKey(file));
    expect(track.size).toBe(1024);
    expect(track.lastModified).toBe(555);
    expect(track.addedAt).toBe(ADDED_AT);
  });

  it('文件被编辑后 cacheKey 变化，但 path 不变（播放进度才不会丢）', () => {
    const before = buildTrack(ref('a.flac'), metadata(), ADDED_AT);
    const after = buildTrack(ref('a.flac', { size: 2048, lastModified: 999 }), metadata(), ADDED_AT);

    expect(after.cacheKey).not.toBe(before.cacheKey);
    expect(after.path).toBe(before.path);
  });
});

describe('buildTrack：播放判定', () => {
  it('Chromium 能解码的扩展名判为可播放', () => {
    expect(buildTrack(ref('a.flac'), metadata(), ADDED_AT).verdict).toBe('decodable');
    expect(buildTrack(ref('b.mp3'), metadata(), ADDED_AT).verdict).toBe('decodable');
    expect(buildTrack(ref('c.ogg'), metadata(), ADDED_AT).verdict).toBe('decodable');
  });

  it('APE / WavPack / DSD 能读标签但不能播放，并带一句可读说明', () => {
    for (const name of ['a.ape', 'b.wv', 'c.dsf', 'd.dff']) {
      const track = buildTrack(ref(name), metadata(), ADDED_AT);
      expect(track.verdict, name).toBe('metadata-only');
      expect(track.verdictNote, name).toContain('无法解码');
    }
  });

  it('.m4a 里的 ALAC 会被 codec 复核降级（只看扩展名会误判为可播放）', () => {
    const track = buildTrack(ref('song.m4a'), metadata({ codec: 'ALAC' }), ADDED_AT);
    expect(track.verdict).toBe('metadata-only');
    expect(track.verdictNote).toContain('ALAC');
  });

  it('.m4a 里的 AAC 仍然是可播放', () => {
    const track = buildTrack(ref('song.m4a'), metadata({ codec: 'AAC' }), ADDED_AT);
    expect(track.verdict).toBe('decodable');
    expect(track.verdictNote).toBeUndefined();
  });

  it('扩展名不在白名单里也不会崩，降级为只能看信息', () => {
    const track = buildTrack(ref('weird.xyz'), metadata(), ADDED_AT);
    expect(track.verdict).toBe('metadata-only');
    expect(track.extension).toBe('xyz');
  });
});

describe('buildTrack：字段透传', () => {
  it('封面只留 hasCover 标记，字节不进曲目对象', () => {
    const track = buildTrack(
      ref('a.flac'),
      metadata({ cover: { mimeType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) } }),
      ADDED_AT,
    );
    expect(track.hasCover).toBe(true);
    expect(Object.keys(track)).not.toContain('cover');
  });

  it('无封面时 hasCover 为 false', () => {
    expect(buildTrack(ref('a.flac'), metadata(), ADDED_AT).hasCover).toBe(false);
  });

  it('解析失败的信息会带到曲目上', () => {
    const track = buildTrack(
      ref('bad.ape'),
      metadata({ title: 'bad', titleFromFileName: true, parseError: 'Failed to determine' }),
      ADDED_AT,
    );
    expect(track.parseError).toBe('Failed to determine');
    expect(track.titleFromFileName).toBe(true);
  });
});
