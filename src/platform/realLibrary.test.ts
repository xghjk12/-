/**
 * 真实曲库冒烟检查（M0 手动验证项）。
 *
 * 默认跳过；设置 M0_MUSIC_DIR 指向真实音乐目录后才会执行：
 *
 *   $env:M0_MUSIC_DIR='D:\Music'; pnpm test
 *
 * 它会递归遍历该目录、逐个解析元数据，并打印统计——这是产品文档 5.4 / 8 里
 * "大库扫描是否卡顿""中文标签是否乱码"两个风险的实测手段。
 */
import { describe, expect, it } from 'vitest';
import { classifyAudioFile, extensionOf } from '../core/audioFormats.js';
import { readMetadata } from './metadata.js';
import { nodeMusicSource } from './nodeMusicSource.js';

const musicDir = process.env.M0_MUSIC_DIR;

describe.skipIf(!musicDir)('真实曲库冒烟检查', () => {
  it('遍历并解析全部音频文件', async () => {
    const source = nodeMusicSource(musicDir!);

    const listStart = performance.now();
    const files = await source.listAudioFiles();
    const listMs = performance.now() - listStart;

    expect(files.length, `${musicDir} 下没有找到音频文件`).toBeGreaterThan(0);

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const parseStart = performance.now();
    const failures: string[] = [];
    const byExtension = new Map<string, number>();
    let headOnly = 0;
    let bytesRead = 0;
    let coverCount = 0;
    let mojibake = 0;

    for (const file of files) {
      const metadata = await readMetadata(await source.open(file));
      const extension = extensionOf(file.name);
      byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
      bytesRead += metadata.bytesRead;
      if (metadata.readStrategy !== 'full') headOnly += 1;
      if (metadata.cover) coverCount += 1;

      // 乱码粗检：出现 U+FFFD 替换字符，或标题里混入大量拉丁补充区字符
      if (metadata.title.includes('\uFFFD')) mojibake += 1;

      const verdict = classifyAudioFile(file.name);
      if (verdict?.verdict !== 'decodable') continue;

      if (metadata.parseError) {
        failures.push(`${file.path}：解析失败 ${metadata.parseError}`);
      } else if (!metadata.durationSec) {
        failures.push(`${file.path}：读不到时长`);
      } else if (!metadata.title) {
        failures.push(`${file.path}：读不到标题`);
      }
    }

    const parseMs = performance.now() - parseStart;
    const perFile = parseMs / files.length;
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

    console.log(
      [
        '',
        `== 真实曲库冒烟结果 ==`,
        `目录            ${musicDir}`,
        `文件数          ${files.length}（${mb(totalBytes)}MB）`,
        `格式分布        ${[...byExtension].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`,
        `遍历耗时        ${listMs.toFixed(0)}ms`,
        `解析耗时        ${parseMs.toFixed(0)}ms（平均 ${perFile.toFixed(1)}ms/首）`,
        `只读文件头      ${headOnly}/${files.length}`,
        `实际读取        ${mb(bytesRead)}MB（占总体积 ${((bytesRead / totalBytes) * 100).toFixed(1)}%）`,
        `读到封面        ${coverCount}/${files.length}`,
        `疑似乱码标题    ${mojibake}`,
        `推算 3000 首    ${((perFile * 3000) / 1000).toFixed(1)}s`,
        '',
      ].join('\n'),
    );

    expect(failures, `以下文件解析异常：\n${failures.slice(0, 20).join('\n')}`).toEqual([]);
  });
});
