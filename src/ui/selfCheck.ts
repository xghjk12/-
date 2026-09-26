/**
 * 内置自检：用 `?selftest=1` 打开时运行，把结果渲染成一张表。
 *
 * 为什么把它做进产品里：界面里最容易出问题的地方（真实浏览器里的元数据解析、
 * 虚拟化是否真的生效、四种播放模式的推进）都无法靠 Node 单测覆盖，而 `showDirectoryPicker()`
 * 又需要真人手势。于是留一个可自动化的入口——`pnpm check:ui` 用本机 Edge 打开它、
 * 逐项断言、再留一张截图（技术方案 9.1）。
 *
 * 自检同时暴露 `window.__qingyinTest`：冒烟脚本用它加载真实样本、双击播放、
 * 断言"真的在出声"，以及检查控制台没有报错。
 */
import { classifyAudioFile, resolveVerdict } from '../core/audioFormats.js';
import { formatTime } from '../core/format.js';
import { DEFAULT_PROBE_BYTES, metadataRegionEnd } from '../core/metadataRegion.js';
import { resolveNextIndex, resolvePrevIndex, shuffleOrder } from '../core/queue.js';
import { compareText } from '../core/sort.js';
import { fixGbkMojibake } from '../core/tagEncoding.js';
import { currentLineIndex, isLyricFileName, parseLyrics } from '../core/lyrics.js';
import type { Track } from '../core/track.js';
import { blobByteSource } from '../platform/byteSource.js';
import { readMetadata } from '../platform/metadata.js';
import { getActiveSource, getAudioElement, useAppStore } from './store.js';
import { getServices } from './services.js';

import apeUrl from '../../tests/fixtures/fake.ape?url';
import plainLrcUrl from '../../tests/fixtures/plain.lrc?url';
import flacUrl from '../../tests/fixtures/sample-cn.flac?url';
import mp3Url from '../../tests/fixtures/sample-cn.mp3?url';
import plainUrl from '../../tests/fixtures/plain.mp3?url';

interface Check {
  label: string;
  actual: unknown;
  expected: unknown;
}

interface FixtureResult {
  name: string;
  size: number;
  title: string;
  artist?: string;
  album?: string;
  container?: string;
  cover?: string;
  durationSec?: number;
  readStrategy: string;
  regionEnd?: number;
  parseError?: string;
}

const FIXTURES: Array<{ name: string; url: string }> = [
  { name: 'sample-cn.flac', url: flacUrl },
  { name: 'sample-cn.mp3', url: mp3Url },
  { name: 'fake.ape', url: apeUrl },
  { name: 'plain.mp3', url: plainUrl },
];

/**
 * 内置样本的固定修改时间。
 *
 * 必须固定：缓存键包含「路径 + 大小 + 修改时间」，而 `new File()` 默认把 lastModified
 * 设成当下时刻——那样每次导入都会被判成"文件变了"，增量缓存的命中路径就永远测不到。
 */
const FIXTURE_MODIFIED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * 只用于"导入曲库"这一步的歌词样本。
 *
 * 单独一个列表是因为 `FIXTURES` 里每一项都会被当作音频去解析，而自检的检查项是按
 * 「第 1 个是 flac、第 2 个是 mp3…」取用的——把 .lrc 混进去会打乱这些下标。
 *
 * `plain.lrc` 与音频 `plain.mp3` 同名（去扩展名后都是 `plain`），所以会被自动认领；
 * 内置的两首「青花瓷」是同一首歌的两种格式，任何按标题匹配的歌词都会歧义，
 * 那是刻意留的"歧义不猜"用例（有单测覆盖）。
 */
const LYRIC_FIXTURES: Array<{ name: string; url: string }> = [
  { name: 'plain.lrc', url: plainLrcUrl },
];

/** 取内置样本字节 + 解析结果（走的是和产品完全相同的浏览器解析路径）。 */
async function inspectFixture(name: string, url: string): Promise<FixtureResult> {
  const response = await fetch(url);
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const metadata = await readMetadata(blobByteSource(blob, name));

  return {
    name,
    size: blob.size,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    container: metadata.container,
    cover: metadata.cover?.mimeType,
    durationSec: metadata.durationSec,
    readStrategy: metadata.readStrategy,
    regionEnd: metadataRegionEnd(bytes.subarray(0, Math.min(DEFAULT_PROBE_BYTES, bytes.length))),
    parseError: metadata.parseError,
  };
}

/** 合成若干曲目，用于验证虚拟化确实只渲染视口内的行。 */
function syntheticTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `合成/${index + 1}.mp3`,
    name: `${index + 1}.mp3`,
    size: 1024,
    lastModified: 1,
    cacheKey: `合成/${index + 1}.mp3\u00001024\u00001`,
    title: `合成曲目 ${index + 1}`,
    titleFromFileName: false,
    artist: '自检',
    album: '虚拟化测试',
    durationSec: 180,
    extension: 'mp3',
    verdict: 'decodable' as const,
    hasCover: false,
    addedAt: 1_700_000_000_000 + index,
  }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );
}

function render(checks: Check[]): boolean {
  const passed = checks.every(
    (check) => JSON.stringify(check.actual) === JSON.stringify(check.expected),
  );

  const rows = checks
    .map((check) => {
      const ok = JSON.stringify(check.actual) === JSON.stringify(check.expected);
      return `<tr><td>${escapeHtml(check.label)}</td><td>${escapeHtml(
        JSON.stringify(check.actual),
      )}</td><td>${escapeHtml(JSON.stringify(check.expected))}</td>
      <td class="${ok ? 'ok' : 'bad'}">${ok ? '通过' : '不通过'}</td></tr>`;
    })
    .join('');

  const container = document.getElementById('selfTestResult');
  if (container) {
    container.innerHTML =
      `<h2>内置自检 — <span class="${passed ? 'ok' : 'bad'}">` +
      `${passed ? '全部通过' : '存在失败项'}</span></h2>` +
      `<table><tr><th>检查项</th><th>实际</th><th>期望</th><th>结果</th></tr>${rows}</table>`;
    container.dataset.verdict = passed ? 'pass' : 'fail';
  }
  document.documentElement.dataset.selfTest = passed ? 'pass' : 'fail';
  return passed;
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function collect(): Promise<Check[]> {
  const results = await Promise.all(
    FIXTURES.map(({ name, url }) => inspectFixture(name, url)),
  );
  const [flac, mp3, ape, plain] = results;
  const checks: Check[] = [];

  checks.push(
    { label: 'flac 容器', actual: flac!.container, expected: 'FLAC' },
    { label: 'flac 标题（中文）', actual: flac!.title, expected: '青花瓷' },
    { label: 'flac 艺术家（中文）', actual: flac!.artist, expected: '周杰伦' },
    { label: 'flac 专辑（中文）', actual: flac!.album, expected: '我很忙' },
    { label: 'flac 内嵌封面', actual: flac!.cover, expected: 'image/jpeg' },
    { label: 'flac 时长（取整）', actual: Math.round(flac!.durationSec ?? 0), expected: 2 },
    { label: 'flac 读取级别', actual: flac!.readStrategy, expected: 'probe' },
    { label: 'flac 元数据区结束偏移', actual: flac!.regionEnd !== undefined && flac!.regionEnd < flac!.size, expected: true },
  );

  checks.push(
    { label: 'mp3 标题（中文）', actual: mp3!.title, expected: '青花瓷' },
    { label: 'mp3 内嵌封面', actual: mp3!.cover, expected: 'image/jpeg' },
    { label: 'mp3 时长（取整）', actual: Math.round(mp3!.durationSec ?? 0), expected: 2 },
    { label: 'mp3 读取级别', actual: mp3!.readStrategy, expected: 'probe' },
    { label: 'mp3 元数据区结束偏移', actual: mp3!.regionEnd !== undefined && mp3!.regionEnd < mp3!.size, expected: true },
  );

  // 损坏文件不能抛异常，要给出 parseError 并回退到文件名标题
  checks.push(
    { label: '损坏文件有 parseError', actual: Boolean(ape!.parseError), expected: true },
    { label: '损坏文件标题回退', actual: ape!.title, expected: 'fake' },
  );

  // 完全没有标签的文件：L3 全文件兜底 + 标题回退文件名
  checks.push(
    { label: '无标签文件标题回退', actual: plain!.title, expected: 'plain' },
    { label: '无标签文件走 L3 全文件兜底', actual: plain!.readStrategy, expected: 'full' },
  );

  // 播放判定：APE 读得出标签但放不出声，必须由我们自己标成"只能看信息"
  const verdict = classifyAudioFile('song.ape');
  checks.push(
    { label: 'APE 标记为 metadata-only', actual: verdict?.verdict, expected: 'metadata-only' },
    {
      label: 'm4a 里的 ALAC 被 codec 复核降级',
      actual: resolveVerdict(classifyAudioFile('song.m4a')!, 'ALAC').verdict,
      expected: 'metadata-only',
    },
  );

  // GBK 老标签：0xC7E0 0xBBA8 0xB4C9 是「青花瓷」的 GBK 字节被按 latin1 读出来的形态
  checks.push({
    label: 'GBK 标签回退',
    actual: fixGbkMojibake(String.fromCharCode(0xc7, 0xe0, 0xbb, 0xa8, 0xb4, 0xc9)),
    expected: '青花瓷',
  });

  // 四种播放模式的推进
  const nextIn = { queueLength: 5, currentIndex: 2, mode: 'repeat-one' as const };
  checks.push(
    {
      label: '单曲循环：自然结束重复本首',
      actual: resolveNextIndex({ ...nextIn, auto: true }),
      expected: 2,
    },
    {
      label: '单曲循环：手动下一首仍前进',
      actual: resolveNextIndex({ ...nextIn, auto: false }),
      expected: 3,
    },
    { label: '顺序播放：末尾返回 -1（停止）', actual: resolveNextIndex({ queueLength: 5, currentIndex: 4, mode: 'sequence' }), expected: -1 },
    { label: '列表循环：末尾回到第一首', actual: resolveNextIndex({ queueLength: 5, currentIndex: 4, mode: 'repeat-all' }), expected: 0 },
    { label: '顺序播放：上一首停在第一首', actual: resolvePrevIndex({ queueLength: 5, currentIndex: 0, mode: 'sequence' }), expected: 0 },
    { label: '列表循环：上一首从队首回到队尾', actual: resolvePrevIndex({ queueLength: 5, currentIndex: 0, mode: 'repeat-all' }), expected: 4 },
    {
      label: '洗牌是 0..n-1 的一个排列',
      actual: [...shuffleOrder(8)].sort((a, b) => a - b).join(','),
      expected: '0,1,2,3,4,5,6,7',
    },
    { label: '中文数字排序（第2首 < 第10首）', actual: compareText('第2首', '第10首') < 0, expected: true },
    { label: '时长格式化', actual: formatTime(125), expected: '2:05' },
  );

  // 歌词解析与当前行定位（网页里也要能跑）
  const parsedLyrics = parseLyrics('[00:00.00]一\n[00:00.40]二\n[00:00.80]三');
  checks.push(
    { label: '歌词解析：行数', actual: parsedLyrics.lines.length, expected: 3 },
    { label: '歌词解析：当前行定位（0.7s → 第 2 句）', actual: currentLineIndex(parsedLyrics.lines, 0.7), expected: 1 },
    { label: '歌词文件识别（.lrc）', actual: isLyricFileName('专辑/青花瓷.LRC'), expected: true },
  );

  // 界面：外壳已挂载 + 虚拟化真的生效
  checks.push({
    label: '应用外壳已挂载',
    actual: Boolean(document.querySelector('.app')),
    expected: true,
  });

  const store = useAppStore.getState();
  const backup = store.tracks;
  useAppStore.setState({ tracks: syntheticTracks(500) });
  await nextFrame();
  const renderedRows = document.querySelectorAll('.row').length;
  useAppStore.setState({ tracks: backup });

  checks.push(
    { label: '虚拟化：500 首只渲染视口内的行', actual: renderedRows > 0 && renderedRows < 100, expected: true },
  );

  return checks;
}

/** 自检模式下的测试钩子：给 `pnpm check:ui` 用。 */
function installTestHooks(): void {
  const hooks = {
    /** 把内置样本当作一个"文件夹"导入，走完整的扫描 → IndexedDB → 列表渲染链路。 */
    async loadFixtureLibrary(): Promise<number> {
      const files = await Promise.all(
        [...FIXTURES, ...LYRIC_FIXTURES].map(async ({ name, url }) => {
          const response = await fetch(url);
          return new File([await response.blob()], name, { lastModified: FIXTURE_MODIFIED_AT });
        }),
      );
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      await useAppStore.getState().useFileList(transfer.files);
      return useAppStore.getState().tracks.length;
    },
    /** 读某首曲目已保存的歌词记录（验证自动认领/导入是否落库）。 */
    readLyrics: async (path: string) => (await getServices()).storage.getLyrics(path),
    /** 调试用：当前来源到底交进来了多少歌词文件。 */
    lyricFiles: async () => {
      const source = getActiveSource();
      if (!source?.listLyricFiles) return { supported: false, count: 0, sample: [] as string[] };
      const refs = await source.listLyricFiles();
      const audio = await source.listAudioFiles();
      return {
        supported: true,
        count: refs.length,
        audioCount: audio.length,
        sample: refs.map((ref) => ref.path),
      };
    },
    /** 本轮扫描的统计（命中 / 新解析 / 遍历耗时…），用于验证增量缓存真的生效。 */
    scan: () => useAppStore.getState().scan,
    /** 直接读 IndexedDB 里持久化的播放状态，验证"写进去的是真数据"。 */
    readPersisted: async () => (await getServices()).storage.readState(),
    setVolume: (volume: number) => useAppStore.getState().setVolume(volume),
    cycleMode: () => useAppStore.getState().cycleMode(),
    togglePlay: () => useAppStore.getState().togglePlay(),
    /**
     * 跳到指定进度并立刻落盘。
     *
     * 冒烟脚本需要一个**确定性**的进度值来验证"进度真的存进了 IndexedDB"，
     * 靠正在播放的曲目自己推进是不确定的（测试样本只有 1–2 秒，很容易已经播完）。
     */
    seekAndFlush: async (positionSec: number) => {
      useAppStore.getState().seek(positionSec);
      const services = await getServices();
      await services.writer.flush();
      return useAppStore.getState().resumePositionSec;
    },
    openQueue: () => useAppStore.getState().toggleQueue(),
    tracks: () => useAppStore.getState().tracks.map((track) => track.path),
    state: () => {
      const state = useAppStore.getState();
      return {
        playing: state.playing,
        mode: state.mode,
        currentIndex: state.currentIndex,
        queueLength: state.queue.length,
        volume: state.volume,
        muted: state.muted,
        drawer: state.drawer,
        queueOpen: state.drawer === 'queue',
        lyricSearchTemplate: state.lyricSearchTemplate,
        resumePath: state.resumePath,
        resumePositionSec: state.resumePositionSec,
        recentPaths: state.recentPaths,
        collapsedGroups: state.collapsedGroups,
        view: state.view,
        ready: state.ready,
        persistent: state.persistent,
      };
    },
    positionSec: () => getAudioElement()?.currentTime ?? 0,
    durationSec: () => getAudioElement()?.duration ?? 0,
    paused: () => getAudioElement()?.paused ?? true,
    audioSrc: () => getAudioElement()?.currentSrc ?? getAudioElement()?.src ?? '',
  };

  (globalThis as unknown as { __qingyinTest?: typeof hooks }).__qingyinTest = hooks;
}

/** 入口：只有 `?selftest=1` 时才做任何事，正常使用零开销。 */
export async function startSelfCheck(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('selftest')) return;

  installTestHooks();

  const panel = document.createElement('div');
  panel.id = 'selfTestResult';
  panel.className = 'selftest';
  document.body.append(panel);

  try {
    const checks = await collect();
    render(checks);
  } catch (error) {
    render([
      {
        label: '自检本身抛出异常',
        actual: error instanceof Error ? error.message : String(error),
        expected: '无异常',
      },
    ]);
  }
}
