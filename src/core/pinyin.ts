/**
 * 拼音首字母：把汉字转成声母，用于「搜 zjl 找到周杰伦」这类检索。
 *
 * 数据来自 `pinyinTable.ts`（由 `scripts/make-pinyin-initials.mjs` 自动生成并抽查过），
 * 这里只负责建表和查询。刻意不引拼音词库：一个 3760 字的声母表只有几 KB，
 * 而完整拼音库要几百 KB，收益（支持全拼）却不改变"能不能快速找到歌"这件事。
 *
 * 已知限制（都写在测试里，避免后人误判）：
 *  - GB2312 二级字区的生僻字没有声母（如「盹」）——它们本来也不适合用首字母检索
 *  - 多音字按 GB2312 排序所依据的读音取声母；声母不同的常用多音字由变体表兜住
 *  - 只支持**首字母**，不支持全拼（搜 qinghua 找不到青花瓷，搜 qhc 可以）
 */
import { PINYIN_TABLE_CHARS, PINYIN_TABLE_INITIALS } from './pinyinTable.js';

/** 汉字 → 声母。3760 条，建表一次约 1ms，之后 O(1)。 */
const INITIAL_BY_CHAR = new Map<string, string>();
for (let index = 0; index < PINYIN_TABLE_CHARS.length; index += 1) {
  const initial = PINYIN_TABLE_INITIALS[index];
  if (initial && initial !== ' ') {
    INITIAL_BY_CHAR.set(PINYIN_TABLE_CHARS[index]!, initial);
  }
}

/**
 * 声母不同的常用多音字。
 *
 * GB2312 的排序只反映一个读音，而歌名 / 人名里另一个读音很常见
 * （「乐队」的乐读 yuè，但表里按 lè 排）。只列**声母确实不同**的字——
 * 声母相同的多音字（如「中」zhōng/zhòng）对首字母检索没有影响，不必列。
 */
const ALTERNATE_INITIALS: Record<string, string> = {
  长: 'z', // cháng → zhǎng
  乐: 'y', // lè → yuè
  重: 'c', // zhòng → chóng
  藏: 'z', // cáng → zàng
  曾: 'z', // céng → zēng
  参: 's', // cān → shēn
  单: 's', // dān → shàn
  弹: 't', // dàn → tán
  调: 't', // diào → tiáo
  恶: 'w', // è → wù
  谷: 'y', // gǔ → yù
  便: 'b', // pián → biàn
  宿: 'x', // sù → xiǔ
  折: 's', // zhé → shé
  朝: 'z', // cháo → zhāo
  行: 'h', // xíng → háng
  会: 'k', // huì → kuài
};

/** 单个字的声母；没有（生僻字、非汉字）时返回 undefined。 */
export function initialOf(char: string): string | undefined {
  return INITIAL_BY_CHAR.get(char);
}

/** 一个字的全部候选声母：表里的读音 + 变体表里的另一读音。 */
function initialsOfChar(char: string): string[] {
  const primary = INITIAL_BY_CHAR.get(char);
  const alternate = ALTERNATE_INITIALS[char];
  if (!primary) return alternate ? [alternate] : [];
  if (!alternate || alternate === primary) return [primary];
  return [primary, alternate];
}

/** 主读音的首字母串（搜 zjl → 周杰伦）。非汉字字符不贡献字母。 */
export function pinyinInitials(text: string | undefined): string {
  if (!text) return '';
  let result = '';
  for (const char of text) {
    const [primary] = initialsOfChar(char);
    if (primary) result += primary;
  }
  return result;
}

/** 变体数量上限：2 个歧义字就有 4 种组合，再多对检索没有实际意义。 */
const MAX_VARIANTS = 4;

/**
 * 全部候选首字母串（含多音字变体），最多 4 个，主读音排第一。
 *
 * 检索时任意一个变体被命中就算命中——这样「乐队」既能被 l 也能被 y 搜到。
 */
export function pinyinInitialsVariants(text: string | undefined): string[] {
  if (!text) return [];

  const chars = [...text];
  const options = chars.map((char) => initialsOfChar(char));
  const ambiguous = options.filter((list) => list.length > 1).length;
  // 歧义字太多时只保留主读音，避免组合爆炸
  if (ambiguous > 2) return [pinyinInitials(text)];

  let variants = [''];
  for (const list of options) {
    if (list.length === 0) continue;
    const next: string[] = [];
    for (const prefix of variants) {
      for (const initial of list) {
        next.push(prefix + initial);
        if (next.length >= MAX_VARIANTS * 2) break;
      }
    }
    variants = next;
  }

  return [...new Set(variants.filter(Boolean))].slice(0, MAX_VARIANTS);
}

/** 文本里是否含汉字（用于决定要不要走首字母检索）。 */
export function hasChinese(text: string | undefined): boolean {
  if (!text) return false;
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}
