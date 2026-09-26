/**
 * M0 手动验证页。
 *
 * 内置自检：直接解析随包打进来的真实 flac / mp3 样本，确认浏览器里 music-metadata
 * 能读出中文标签、封面与时长。不依赖用户文件，打开就能跑。
 *
 * 曲库验证：走一遍"选目录 → 递归遍历 → 逐个解析"，用来在真实曲库上看扫描耗时、
 * 头部读取命中率与格式分布。
 */
import { readMetadata } from '../src/platform/metadata.js';
import type { TrackMetadata } from '../src/platform/metadata.js';
import { blobByteSource } from '../src/platform/byteSource.js';
import { classifyAudioFile, resolveVerdict } from '../src/core/audioFormats.js';
import type { MusicSource } from '../src/platform/musicSource.js';
import {
  collectFromDirectoryHandle,
  getDirectoryPicker,
  sourceFromFileList,
} from './browserMusicSource.js';

import flacUrl from '../tests/fixtures/sample-cn.flac?url';
import mp3Url from '../tests/fixtures/sample-cn.mp3?url';

const logElement = document.querySelector<HTMLDivElement>('#log')!;
const selfTestResult = document.querySelector<HTMLDivElement>('#selfTestResult')!;
const libraryResult = document.querySelector<HTMLDivElement>('#libraryResult')!;

function log(message: string): void {
  logElement.textContent = message;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '—';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function coverCell(metadata: TrackMetadata): string {
  if (!metadata.cover) return '—';
  const blob = new Blob([metadata.cover.data as BlobPart], { type: metadata.cover.mimeType });
  return `<img class="cover" src="${URL.createObjectURL(blob)}" alt="封面" />`;
}

interface Check {
  label: string;
  actual: unknown;
  expected: unknown;
}

function renderChecks(container: HTMLElement, title: string, checks: Check[]): boolean {
  const rows = checks
    .map((check) => {
      const pass = JSON.stringify(check.actual) === JSON.stringify(check.expected);
      return `<tr><td>${escapeHtml(check.label)}</td>
        <td>${escapeHtml(JSON.stringify(check.actual))}</td>
        <td>${escapeHtml(JSON.stringify(check.expected))}</td>
        <td class="${pass ? 'ok' : 'bad'}">${pass ? '通过' : '不通过'}</td></tr>`;
    })
    .join('');
  const allPassed = checks.every(
    (check) => JSON.stringify(check.actual) === JSON.stringify(check.expected),
  );
  container.innerHTML =
    `<h2>${escapeHtml(title)} — <span class="${allPassed ? 'ok' : 'bad'}">` +
    `${allPassed ? '全部通过' : '存在失败项'}</span></h2>` +
    `<table><tr><th>检查项</th><th>实际</th><th>期望</th><th>结果</th></tr>${rows}</table>`;
  return allPassed;
}

async function parseAsset(url: string, name: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  const started = performance.now();
  const metadata = await readMetadata(blobByteSource(blob, name));
  return { metadata, elapsedMs: performance.now() - started, size: blob.size };
}

/** 内置自检：不依赖用户文件，打开页面即可运行。 */
async function runSelfTest(): Promise<void> {
  selfTestResult.innerHTML = '';
  log('正在解析内置样本…');

  const flac = await parseAsset(flacUrl, 'sample-cn.flac');
  const mp3 = await parseAsset(mp3Url, 'sample-cn.mp3');

  const checks: Check[] = [
    { label: 'flac 容器', actual: flac.metadata.container, expected: 'FLAC' },
    { label: 'flac 标题（中文）', actual: flac.metadata.title, expected: '青花瓷' },
    { label: 'flac 艺术家（中文）', actual: flac.metadata.artist, expected: '周杰伦' },
    { label: 'flac 专辑（中文）', actual: flac.metadata.album, expected: '我很忙' },
    { label: 'flac 时长', actual: Math.round(flac.metadata.durationSec ?? 0), expected: 2 },
    { label: 'flac 读取策略', actual: flac.metadata.readStrategy, expected: 'head' },
    {
      label: 'flac 封面类型',
      actual: flac.metadata.cover?.mimeType ?? null,
      expected: 'image/jpeg',
    },
    { label: 'mp3 标题（中文）', actual: mp3.metadata.title, expected: '青花瓷' },
    { label: 'mp3 时长', actual: Math.round(mp3.metadata.durationSec ?? 0), expected: 2 },
    { label: 'mp3 读取策略', actual: mp3.metadata.readStrategy, expected: 'head' },
  ];

  const passed = renderChecks(selfTestResult, '内置自检（music-metadata + parseBuffer）', checks);
  log(
    `内置自检完成：${passed ? '全部通过' : '存在失败项'}\n` +
      `flac ${(flac.size / 1024).toFixed(1)}KB 解析 ${flac.elapsedMs.toFixed(1)}ms\n` +
      `mp3  ${(mp3.size / 1024).toFixed(1)}KB 解析 ${mp3.elapsedMs.toFixed(1)}ms\n` +
      `两个文件都只读了文件头（readStrategy=head）。`,
  );
}

/** 曲库验证：遍历真实目录并逐个解析。 */
async function runLibraryCheck(source: MusicSource): Promise<void> {
  libraryResult.innerHTML = '';

  const listStart = performance.now();
  const files = await source.listAudioFiles((found) => log(`已发现 ${found} 个音频文件…`));
  const listMs = performance.now() - listStart;

  if (files.length === 0) {
    libraryResult.innerHTML = '<h2 class="warn">没有找到音频文件</h2>';
    return;
  }

  const parseStart = performance.now();
  const rows: string[] = [];
  const byExtension = new Map<string, number>();
  let headOnly = 0;
  let bytesRead = 0;
  let covers = 0;
  let failures = 0;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  for (const [index, ref] of files.entries()) {
    const metadata = await readMetadata(await source.open(ref));
    bytesRead += metadata.bytesRead;
    if (metadata.readStrategy === 'head') headOnly += 1;
    if (metadata.cover) covers += 1;
    if (metadata.parseError) failures += 1;
    byExtension.set(
      classifyAudioFile(ref.name)!.extension,
      (byExtension.get(classifyAudioFile(ref.name)!.extension) ?? 0) + 1,
    );

    if (index < 200) {
      const verdict = resolveVerdict(classifyAudioFile(ref.name)!, metadata.codec);
      const status = metadata.parseError
        ? `<span class="bad">解析失败</span>`
        : verdict.verdict === 'decodable'
          ? '<span class="ok">可播放</span>'
          : `<span class="warn">${escapeHtml(verdict.note ?? '不可播放')}</span>`;
      rows.push(
        `<tr><td>${coverCell(metadata)}</td>
          <td>${escapeHtml(metadata.title)}</td>
          <td>${escapeHtml(metadata.artist ?? '—')}</td>
          <td>${escapeHtml(metadata.album ?? '—')}</td>
          <td class="num">${formatDuration(metadata.durationSec)}</td>
          <td class="num">${(ref.size / 1024 / 1024).toFixed(1)}MB</td>
          <td>${escapeHtml(metadata.readStrategy)}</td>
          <td>${status}</td></tr>`,
      );
    }
    if (index % 50 === 0 || index === files.length - 1) {
      log(`解析中 ${index + 1}/${files.length}：${ref.path}`);
    }
  }

  const parseMs = performance.now() - parseStart;
  const perFile = parseMs / files.length;
  const mb = (value: number) => (value / 1024 / 1024).toFixed(1);

  libraryResult.innerHTML =
    `<h2>曲库验证结果</h2>
     <div class="summary">
       <div><dt>根目录</dt><dd>${escapeHtml(source.rootName)}</dd></div>
       <div><dt>文件数</dt><dd>${files.length}（${mb(totalBytes)}MB）</dd></div>
       <div><dt>格式分布</dt><dd>${
         [...byExtension]
           .sort((a, b) => b[1] - a[1])
           .map(([name, count]) => `${escapeHtml(name)}:${count}`)
           .join('　') || '—'
       }</dd></div>
       <div><dt>遍历耗时</dt><dd>${listMs.toFixed(0)}ms</dd></div>
       <div><dt>解析耗时</dt><dd>${parseMs.toFixed(0)}ms（平均 ${perFile.toFixed(1)}ms/首）</dd></div>
       <div><dt>只读文件头</dt><dd>${headOnly}/${files.length}</dd></div>
       <div><dt>实际读取</dt><dd>${mb(bytesRead)}MB（占总体积 ${((bytesRead / totalBytes) * 100).toFixed(1)}%）</dd></div>
       <div><dt>读到封面</dt><dd>${covers}/${files.length}</dd></div>
       <div><dt>解析失败</dt><dd class="${failures ? 'bad' : 'ok'}">${failures}</dd></div>
       <div><dt>推算 3000 首</dt><dd>${((perFile * 3000) / 1000).toFixed(1)}s</dd></div>
     </div>
     ${files.length > 200 ? '<p class="lead">下表只展示前 200 首。</p>' : ''}
     <table>
       <tr><th>封面</th><th>标题</th><th>艺术家</th><th>专辑</th><th>时长</th>
           <th>大小</th><th>读取</th><th>判定</th></tr>
       ${rows.join('')}
     </table>`;

  log(`曲库验证完成：${files.length} 个文件，解析耗时 ${parseMs.toFixed(0)}ms。`);
}

document.querySelector('#selfTest')!.addEventListener('click', () => {
  void runSelfTest();
});

document.querySelector('#pick')!.addEventListener('click', async () => {
  const picker = getDirectoryPicker();
  if (!picker) {
    log('当前浏览器不支持 showDirectoryPicker（需要 Chrome / Edge），请用"input 回退路"。');
    return;
  }
  try {
    log('请在系统对话框里选择音乐文件夹…');
    const handle = await picker({ mode: 'read' });
    const source = await collectFromDirectoryHandle(handle, (found) =>
      log(`已发现 ${found} 个音频文件…`),
    );
    await runLibraryCheck(source);
  } catch (error) {
    log(`已取消或失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

document.querySelector('#fallback')!.addEventListener('click', () => {
  document.querySelector<HTMLInputElement>('#fallbackInput')!.click();
});

document.querySelector<HTMLInputElement>('#fallbackInput')!.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  void runLibraryCheck(sourceFromFileList(input.files));
});

void runSelfTest();
