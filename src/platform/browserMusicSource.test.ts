/**
 * 浏览器曲库来源的测试。
 *
 * 这段代码没法在 Node 里真的调 `showDirectoryPicker()`，但**两条入口的路径约定**是纯逻辑，
 * 而且它是缓存能否命中的前提：`<input webkitdirectory>` 给的 `webkitRelativePath`
 * 比句柄模式多一层根目录名，如果不在这一层剥掉，同一个文件换个入口就会算出不同的缓存键、
 * 整个曲库重扫一遍。所以这里用假的 FileList 把约定锁死。
 */
import { describe, expect, it, vi } from 'vitest';
import { collectFromDirectoryHandle, sourceFromFileList } from './browserMusicSource.js';
import type { DirectoryHandleLike, EntryHandle } from './browserMusicSource.js';

/** 造一个带 webkitRelativePath 的 File（这个属性是只读的，只能 defineProperty）。 */
function fakeFile(name: string, relativePath?: string, size = 128): File {
  const file = new File([new Uint8Array(size)], name);
  if (relativePath !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  }
  return file;
}

function asFileList(files: File[]): FileList {
  return files as unknown as FileList;
}

describe('sourceFromFileList：路径约定', () => {
  it('剥掉用户选中的根目录名，与句柄模式保持一致', () => {
    const source = sourceFromFileList(
      asFileList([
        fakeFile('01 第一首.flac', '我的音乐/专辑/01 第一首.flac'),
        fakeFile('02 第二首.mp3', '我的音乐/专辑/02 第二首.mp3'),
      ]),
    );

    expect(source.rootName).toBe('我的音乐');
    return expect(source.listAudioFiles()).resolves.toMatchObject([
      { path: '专辑/01 第一首.flac', name: '01 第一首.flac' },
      { path: '专辑/02 第二首.mp3', name: '02 第二首.mp3' },
    ]);
  });

  it('直接躺在根目录下的文件，路径就是文件名（与句柄模式一致）', async () => {
    const source = sourceFromFileList(asFileList([fakeFile('a.flac', '音乐/a.flac')]));
    const refs = await source.listAudioFiles();
    expect(refs[0]?.path).toBe('a.flac');
  });

  it('非音频文件被过滤掉', async () => {
    const source = sourceFromFileList(
      asFileList([
        fakeFile('cover.jpg', '音乐/cover.jpg'),
        fakeFile('notes.txt', '音乐/notes.txt'),
        fakeFile('a.flac', '音乐/a.flac'),
      ]),
    );

    const refs = await source.listAudioFiles();
    expect(refs.map((ref) => ref.name)).toEqual(['a.flac']);
  });

  it('没有 webkitRelativePath 时退回文件名', async () => {
    const source = sourceFromFileList(asFileList([fakeFile('solo.mp3')]));
    const refs = await source.listAudioFiles();
    expect(refs[0]?.path).toBe('solo.mp3');
    expect(source.rootName).toBe('已选择的文件夹');
  });

  it('列出时带上大小、修改时间，并回调进度', async () => {
    const progress: number[] = [];
    const source = sourceFromFileList(
      asFileList([fakeFile('a.flac', '音乐/a.flac', 2048), fakeFile('b.mp3', '音乐/b.mp3', 64)]),
    );

    const refs = await source.listAudioFiles((found) => progress.push(found));

    expect(progress).toEqual([1, 2]);
    expect(refs[0]).toMatchObject({ size: 2048 });
    expect(Number.isFinite(refs[0]?.lastModified)).toBe(true);
  });
});

describe('sourceFromFileList：打开与播放', () => {
  it('open 返回能按区间读取的字节源，且区间被裁剪到文件范围', async () => {
    const file = fakeFile('a.flac', '音乐/a.flac', 100);
    const source = sourceFromFileList(asFileList([file]));
    const ref = (await source.listAudioFiles())[0]!;

    const byteSource = await source.open(ref);
    expect(byteSource.size).toBe(100);
    expect(byteSource.name).toBe('a.flac');

    const head = await byteSource.read(0, 32);
    expect(head.length).toBe(32);
    // 越过末尾的请求会被裁到文件大小
    const over = await byteSource.read(90, 500);
    expect(over.length).toBe(10);
    const empty = await byteSource.read(100, 200);
    expect(empty.length).toBe(0);
  });

  it('getFile 拿回原始 File，供 <audio> 播放（不读进内存）', async () => {
    const file = fakeFile('a.flac', '音乐/a.flac');
    const source = sourceFromFileList(asFileList([file]));
    expect(source.getFile('a.flac')).toBe(file);
    expect(source.getFile('不存在.flac')).toBeUndefined();
  });

  it('打开不存在的路径会抛错，而不是静默返回空', async () => {
    const source = sourceFromFileList(asFileList([fakeFile('a.flac', '音乐/a.flac')]));
    await expect(
      source.open({ path: 'b.flac', name: 'b.flac', size: 1, lastModified: 1 }),
    ).rejects.toThrow('找不到文件');
  });
});

describe('collectFromDirectoryHandle：递归遍历', () => {
  /** 用普通对象模拟目录句柄：只需要 kind / name / values()。 */
  function fakeDir(name: string, entries: EntryHandle[]): DirectoryHandleLike {
    return {
      kind: 'directory',
      name,
      values: async function* () {
        for (const entry of entries) yield entry;
      },
    };
  }

  function fakeFileHandle(name: string, size = 100) {
    return {
      kind: 'file' as const,
      name,
      getFile: async () => fakeFile(name, undefined, size),
    };
  }

  it('递归找到全部音频文件，忽略其它文件与空目录', async () => {
    const handle = fakeDir('我的音乐', [
      fakeFileHandle('a.flac'),
      { kind: 'file', name: 'cover.jpg', getFile: async () => fakeFile('cover.jpg') },
      fakeDir('专辑', [fakeFileHandle('b.mp3'), fakeFileHandle('c.mp3')]),
      fakeDir('空目录', []),
    ]);

    const source = await collectFromDirectoryHandle(handle);
    const refs = await source.listAudioFiles();

    expect(source.rootName).toBe('我的音乐');
    expect(refs.map((ref) => ref.path).sort()).toEqual(['a.flac', '专辑/b.mp3', '专辑/c.mp3']);
  });

  it('进度回调单调递增到总数', async () => {
    const onProgress = vi.fn();
    const handle = fakeDir('音乐', [fakeFileHandle('a.flac'), fakeFileHandle('b.mp3')]);

    await collectFromDirectoryHandle(handle, onProgress);

    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([1, 2]);
  });

  it('两条入口对同一批文件算出相同的相对路径', async () => {
    const handle = fakeDir('我的音乐', [
      fakeDir('专辑', [fakeFileHandle('01 第一首.flac')]),
    ]);
    const fromHandle = await (await collectFromDirectoryHandle(handle)).listAudioFiles();
    const fromList = await sourceFromFileList(
      asFileList([fakeFile('01 第一首.flac', '我的音乐/专辑/01 第一首.flac')]),
    ).listAudioFiles();

    expect(fromList.map((ref) => ref.path)).toEqual(fromHandle.map((ref) => ref.path));
  });
});

describe('歌词文件的收集', () => {
  it('FileList 入口会把 .lrc 收进歌词表，且不混进音频表', async () => {
    const source = sourceFromFileList(
      asFileList([
        fakeFile('01 青花瓷.flac', '音乐/专辑/01 青花瓷.flac'),
        fakeFile('01 青花瓷.lrc', '音乐/专辑/01 青花瓷.lrc'),
        fakeFile('cover.jpg', '音乐/专辑/cover.jpg'),
        fakeFile('周杰伦 - 我很忙.LRC', '音乐/专辑/周杰伦 - 我很忙.LRC'),
      ]),
    );

    const audio = await source.listAudioFiles();
    const lyrics = await source.listLyricFiles();

    expect(audio.map((ref) => ref.path)).toEqual(['专辑/01 青花瓷.flac']);
    expect(lyrics.map((ref) => ref.path)).toEqual([
      '专辑/01 青花瓷.lrc',
      '专辑/周杰伦 - 我很忙.LRC',
    ]);
  });

  it('openLyricBytes 能读出歌词内容（保持原始字节，解码交给 core）', async () => {
    const gbk = new Uint8Array([0xc7, 0xe0, 0xbb, 0xa8, 0xb4, 0xc9]);
    const file = new File([gbk], 'a.lrc');
    Object.defineProperty(file, 'webkitRelativePath', { value: '音乐/a.lrc' });
    const source = sourceFromFileList(asFileList([file]));

    const refs = await source.listLyricFiles();
    expect(refs).toHaveLength(1);
    await expect(source.openLyricBytes(refs[0]!)).resolves.toEqual(gbk);
  });

  it('句柄入口同样收集 .lrc，且递归子目录', async () => {
    const handle: DirectoryHandleLike = {
      kind: 'directory',
      name: '音乐',
      values: async function* () {
        yield {
          kind: 'file' as const,
          name: 'a.flac',
          getFile: async () => fakeFile('a.flac'),
        };
        yield {
          kind: 'file' as const,
          name: 'a.lrc',
          getFile: async () => fakeFile('a.lrc'),
        };
        yield {
          kind: 'directory' as const,
          name: '歌词',
          values: async function* () {
            yield {
              kind: 'file' as const,
              name: 'b.lrc',
              getFile: async () => fakeFile('b.lrc'),
            };
          },
        };
      },
    };

    const source = await collectFromDirectoryHandle(handle);
    const lyrics = await source.listLyricFiles();

    expect(lyrics.map((ref) => ref.path).sort()).toEqual(['a.lrc', '歌词/b.lrc']);
  });
});
