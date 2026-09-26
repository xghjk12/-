/**
 * 歌词面板与播放条上的迷你歌词。
 *
 * 两处都遵守同一条纪律：**当前行不进全局 store**。它们各自用 rAF 读播放位置、算当前行，
 * 且只在"行号真的变了"的时候才 setState——一首歌里行号变化不过几十次，
 * 这样既有高亮又不会让曲目列表跟着重渲染。
 *
 * 歌词来源分三层（优先级从高到低）：
 *  1. 用户导入 / 粘贴的（`import` / `paste`）
 *  2. 扫描时认领的同名 `.lrc`（`sidecar`）
 *  3. 没有 → 空状态给出三个入口：拖入 .lrc、粘贴歌词、去搜歌词
 *
 * 「去搜歌词」只做两件事：按用户配置的模板拼一条 URL 交给浏览器打开，
 * 以及复制搜索关键词。**应用不请求、不解析任何第三方内容**（见产品技术文档 2 节）。
 */
import { useEffect, useRef, useState } from 'react';
import { currentLineIndex, lyricSearchKeyword, buildLyricSearchUrl } from '../core/lyrics.js';
import { effectiveOffsetSec, readLyricFile, useLyrics } from './lyrics.js';
import { readLiveProgress, useAppStore } from './store.js';
import { CloseIcon, MusicIcon, SearchIcon, WarnIcon } from './Icons.js';

const SOURCE_LABEL: Record<string, string> = {
  sidecar: '来自文件夹同名文件',
  import: '手动导入',
  paste: '粘贴的文本',
};

/** 当前曲目的路径：优先播放队列里的当前项，否则用"上次播放"。 */
function useCurrentPath(): string | undefined {
  return useAppStore((state) => state.queue[state.currentIndex] ?? state.resumePath);
}

export function LyricsPanel() {
  const currentPath = useCurrentPath();
  const track = useAppStore((state) => state.tracks.find((item) => item.path === currentPath));
  const template = useAppStore((state) => state.lyricSearchTemplate);
  const saveLyrics = useAppStore((state) => state.saveLyrics);
  const removeLyrics = useAppStore((state) => state.removeLyrics);
  const nudgeOffset = useAppStore((state) => state.nudgeLyricOffset);
  const setTemplate = useAppStore((state) => state.setLyricSearchTemplate);
  const rescanLyrics = useAppStore((state) => state.rescanLyrics);
  const seek = useAppStore((state) => state.seek);
  const pushNotice = useAppStore((state) => state.pushNotice);

  const { record, lyrics, loading } = useLyrics(currentPath);
  const offset = effectiveOffsetSec(record, lyrics);

  const [activeIndex, setActiveIndex] = useState(-1);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [draft, setDraft] = useState(template);

  const listRef = useRef<HTMLDivElement>(null);
  const lastUserScroll = useRef(0);

  // 当前行：rAF 里只在行号变化时才更新 state
  useEffect(() => {
    if (!lyrics?.synced) {
      setActiveIndex(-1);
      return;
    }
    let frame = 0;
    let last = Number.NaN;
    const tick = (): void => {
      const { positionSec } = readLiveProgress();
      const index = currentLineIndex(lyrics.lines, positionSec, offset);
      if (index !== last) {
        last = index;
        setActiveIndex(index);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lyrics, offset]);

  // 自动滚到当前行；用户刚手动滚过就先别抢（3 秒）
  useEffect(() => {
    if (activeIndex < 0) return;
    if (Date.now() - lastUserScroll.current < 3000) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-line="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex]);

  useEffect(() => setDraft(template), [template]);

  const importFile = async (file: File): Promise<void> => {
    if (!currentPath) return;
    try {
      const text = await readLyricFile(file);
      await saveLyrics(currentPath, text, 'import');
    } catch (error) {
      pushNotice(`歌词读取失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  const openSearch = (): void => {
    const url = buildLyricSearchUrl(template, {
      title: track?.title ?? '',
      artist: track?.artist,
      album: track?.album,
      trackNo: track?.trackNo,
    });
    if (!url) {
      setTemplateOpen(true);
      pushNotice('请先填写歌词搜索地址模板', 'warn');
      return;
    }
    // 只打开新标签页，不请求、不解析
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const copyKeyword = async (): Promise<void> => {
    const keyword = lyricSearchKeyword({ title: track?.title ?? '', artist: track?.artist });
    try {
      await navigator.clipboard.writeText(keyword);
      pushNotice(`已复制搜索关键词：${keyword}`);
    } catch {
      // 剪贴板权限可能被拒，退化成提示用户手动复制
      pushNotice(`搜索关键词：${keyword}`, 'info');
    }
  };

  if (!currentPath) {
    return (
      <div className="lyrics lyrics-empty">
        <MusicIcon size={20} />
        <p>还没有正在播放的曲目，双击一首歌就能看到歌词。</p>
      </div>
    );
  }

  return (
    <div
      className={`lyrics${dragging ? ' lyrics-dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void importFile(file);
      }}
    >
      <header className="lyrics-head">
        <span className="lyrics-title" title={track?.title}>
          {track?.title ?? currentPath}
        </span>
        {record && (
          <div className="lyrics-actions">
            <span className="lyrics-source">{SOURCE_LABEL[record.source] ?? record.source}</span>
            <button className="btn-icon" title="移除歌词" onClick={() => void removeLyrics(currentPath)}>
              <CloseIcon size={14} />
            </button>
          </div>
        )}
      </header>

      {record && (
        <div className="lyrics-offset">
          <span>时间轴偏移 {offset >= 0 ? '+' : ''}{offset.toFixed(1)}s</span>
          <button className="btn btn-quiet" onClick={() => void nudgeOffset(currentPath, 0.5)} title="歌词提前 0.5 秒">
            提早 0.5s
          </button>
          <button className="btn btn-quiet" onClick={() => void nudgeOffset(currentPath, -0.5)} title="歌词延后 0.5 秒">
            延后 0.5s
          </button>
          {record.userOffsetSec !== 0 && (
            <button className="btn btn-quiet" onClick={() => void nudgeOffset(currentPath, -record.userOffsetSec)}>
              归零
            </button>
          )}
        </div>
      )}

      <div
        className="lyrics-body"
        ref={listRef}
        onScroll={() => {
          lastUserScroll.current = Date.now();
        }}
      >
        {loading && <p className="lyrics-note">正在读取歌词…</p>}

        {!loading && lyrics?.synced &&
          lyrics.lines.map((line, index) => (
            <p
              key={`${line.timeSec}-${index}`}
              data-line={index}
              className={`lyric-line${index === activeIndex ? ' lyric-active' : ''}${line.text ? '' : ' lyric-gap'}`}
              onClick={() => seek(Math.max(0, line.timeSec - offset))}
              title="点击跳到这一句"
            >
              {line.text || '♪'}
            </p>
          ))}

        {!loading && lyrics && !lyrics.synced && (
          <div className="lyrics-plain">
            <p className="lyrics-note">这份歌词没有时间轴，只能整体阅读。</p>
            {lyrics.plainLines.map((line, index) => (
              <p key={index} className="lyric-line">
                {line}
              </p>
            ))}
          </div>
        )}

        {!loading && !lyrics && (
          <div className="lyrics-missing">
            <p>这首歌还没有歌词。</p>
            <div className="lyrics-entries">
              <label className="btn">
                导入 .lrc 文件
                <input
                  type="file"
                  accept=".lrc,.txt,text/plain"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importFile(file);
                    event.target.value = '';
                  }}
                />
              </label>
              <button className="btn" onClick={() => setPasteOpen((open) => !open)}>
                粘贴歌词文本
              </button>
              <button className="btn" onClick={openSearch}>
                <SearchIcon size={13} /> 去搜歌词
              </button>
            </div>
            <p className="lyrics-note">也可以直接把 .lrc 文件拖到这块区域。</p>
          </div>
        )}
      </div>

      {pasteOpen && (
        <div className="lyrics-paste">
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder="把网页上的歌词粘到这里。带 [00:12.34] 这种时间戳就是同步歌词，没有也能显示。"
            rows={4}
          />
          <div className="lyrics-paste-actions">
            <button
              className="btn btn-primary"
              disabled={!pasteText.trim()}
              onClick={() => {
                void saveLyrics(currentPath, pasteText, 'paste');
                setPasteText('');
                setPasteOpen(false);
              }}
            >
              保存歌词
            </button>
            <button className="btn btn-quiet" onClick={() => setPasteOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {(templateOpen || template) && (
        <div className="lyrics-search">
          <div className="lyrics-search-head">
            <span>歌词搜索地址（你自己填的站点，与本应用无关）</span>
            <button className="btn-icon" onClick={() => setTemplateOpen((open) => !open)} title="编辑">
              <SearchIcon size={13} />
            </button>
          </div>
          {templateOpen && (
            <>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="https://你要用的站点/search?q={keyword}"
                aria-label="歌词搜索地址模板"
              />
              <p className="lyrics-note">
                可用占位符：<code>{'{keyword}'}</code>（艺术家 + 标题）、<code>{'{title}'}</code>、
                <code>{'{artist}'}</code>、<code>{'{album}'}</code>、<code>{'{trackNo}'}</code>。
                只接受 http / https 地址。
              </p>
              <div className="lyrics-search-actions">
                <button className="btn btn-primary" onClick={() => { void setTemplate(draft); setTemplateOpen(false); }}>
                  保存
                </button>
                <button className="btn btn-quiet" onClick={() => { setDraft(template); setTemplateOpen(false); }}>
                  取消
                </button>
                <button className="btn btn-quiet" onClick={() => void copyKeyword()}>
                  复制关键词
                </button>
              </div>
            </>
          )}
          {!templateOpen && (
            <p className="lyrics-note">
              应用只负责按模板打开新标签页，不会请求或解析对方的内容。下载好的 .lrc
              放进音乐文件夹（或直接拖到上面）就能用。
            </p>
          )}
        </div>
      )}

      <footer className="lyrics-foot">
        {!template && !templateOpen && (
          <button className="btn btn-quiet" onClick={() => setTemplateOpen(true)}>
            设置歌词搜索地址
          </button>
        )}
        <button className="btn btn-quiet" onClick={() => void rescanLyrics()} title="重新在曲库里找 .lrc">
          重新扫描歌词
        </button>
      </footer>
    </div>
  );
}

/** 播放条上方的迷你歌词：一行，点击打开歌词面板。 */
export function MiniLyric() {
  const currentPath = useCurrentPath();
  const toggleLyrics = useAppStore((state) => state.toggleLyrics);
  const { record, lyrics } = useLyrics(currentPath);
  const offset = effectiveOffsetSec(record, lyrics);

  const [text, setText] = useState('');

  useEffect(() => {
    if (!lyrics) {
      setText('');
      return;
    }
    if (!lyrics.synced) {
      setText(lyrics.plainLines[0] ?? '');
      return;
    }
    let frame = 0;
    let last = Number.NaN;
    const tick = (): void => {
      const { positionSec } = readLiveProgress();
      const index = currentLineIndex(lyrics.lines, positionSec, offset);
      if (index !== last) {
        last = index;
        setText(index >= 0 ? (lyrics.lines[index]?.text ?? '') : '');
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lyrics, offset]);

  if (!currentPath || !lyrics) return null;

  return (
    <button className="minilyric" onClick={toggleLyrics} title="打开歌词面板">
      {text ? (
        <span className="minilyric-text">{text}</span>
      ) : (
        <span className="minilyric-idle">
          <WarnIcon size={12} /> 暂无歌词，点击查看歌词面板
        </span>
      )}
    </button>
  );
}
