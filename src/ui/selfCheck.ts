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
import type { Track } from '../core/track.js';
import { blobByteSource } from '../platform/byteSource.js';
import { readMetadata } from '../platform/metadata.js';
import { getAudioElement, useAppStore } from './store.js';

import apeUrl from '../../tests/fixtures/fake.ape?url';
import flacUrl from '../../tests/fixtures/sample-cn.flac?url';
import mp3Url from '../../tests/fixtures/sample-cn.mp3?url';

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
  const [flac, mp3, ape] = await Promise.all(FIXTURES.map(({ name, url }) => inspectFixture(name, url)));
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
        FIXTURES.map(async ({ name, url }) => {
          const response = await fetch(url);
          return new File([await response.blob()], name);
        }),
      );
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      await useAppStore.getState().useFileList(transfer.files);
      return useAppStore.getState().tracks.length;
    },
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
        queueOpen: state.queueOpen,
        resumePath: state.resumePath,
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
