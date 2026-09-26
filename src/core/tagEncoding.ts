/**
 * 老 mp3 的 ID3v2 标签编码回退。纯逻辑，不引用任何平台 API。
 *
 * 为什么需要这个模块：一批老 mp3 的 ID3v2 编码字节写着 `0x00`（声明 ISO-8859-1），
 * 实际塞进去的却是 GBK 字节。ISO-8859-1 是单字节编码，任何字节都能解出字符，
 * 所以 music-metadata 会"成功"地把 GBK 字节逐字节按 latin1 解成乱码——不报错、
 * 不抛异常，只是标题变成一串 U+0080–U+00FF 的怪字符（例如 `青花瓷` 的
 * `C7 E0 BB A8 B4 C9` 会变成 `Çà»¨´É`）。这不是解析失败，而是编码声明与内容不符。
 *
 * 修正思路是反向的：把每个码位当成一个字节取回来，再用 GBK 重解码。难点在于
 * **GBK 无法可靠地反推**——任意字节序列都能被 GBK 解出"某个结果"，而合法的
 * latin1 文本（`Björk`、`Café`）同样长得像字节，一旦误判就会把正确的内容改成
 * 另一种乱码。所以判定必须保守：宁可保留乱码，也不要错改。下面每个阈值都是
 * 按这个方向偏的，且必须同时满足多项独立条件才会真的采用修正结果。
 */

/** 注入式解码器：拿到字节返回解码结果；注入是为了让 core 保持纯逻辑且可测。 */
export type LegacyDecoder = (bytes: Uint8Array) => string | undefined;

/**
 * 识别乱码所需的最少高位字节数。
 *
 * 取 2 而不是 1，是因为单个 U+0080–U+00FF 字符在合法的 latin1 文本里太常见了：
 * `Björk`、`Café` 都只有一个这样的字符。真正的 GBK 乱码是整串字节被 latin1 解出来的，
 * 至少两个汉字才有区分度（而两个汉字的 GBK 字节必然是两个以上的高位字节）。
 */
const MIN_HIGH_BYTES = 2;

/**
 * 高位字节占"非 ASCII 字符"的最低比例。
 *
 * 没有 CJK 汉字且一半以上的非 ASCII 内容都落在 U+0080–U+00FF，才像"整串被 latin1 解码"。
 * 用比例而不是绝对数量，是为了排除混排：`Björk 青花瓷` 里高位字节只占非 ASCII 的一小部分，
 * 说明这串文本本来就是正常解码的，不该动。
 */
const MIN_HIGH_RATIO = 0.5;

/**
 * 修正结果的最低长度比：GBK 双字节字符会吃掉两个字节，所以正常修正后的长度应当
 * 明显短于输入（单字节 ASCII 仍是 1:1）。若结果没有变短，说明字节流并没有被当作
 * 双字节序列消费，解码结果不可信。
 */
const MAX_RESULT_RATIO = 1;

/** CJK 汉字的码位：基本区 U+4E00–U+9FFF 与扩展 A U+3400–U+4DBF。 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 结果是乱码残留或不可见控制字符时一律放弃：U+FFFD、C0、C1、DEL。
 *
 * 真实的 latin1 标签文本（含 `Björk` 这类西文）不会带控制字符，所以输入里出现
 * C0/DEL/C1 就说明它根本不是"整串字节被 latin1 解出来"的结果，而是别的东西；
 * 同理，GBK 解码结果里冒出控制字符，说明字节流没被当成合法 GBK 消费。
 */
const CONTROL_OR_REPLACEMENT_PATTERN = /[\u0000-\u001f\u007f-\u009f\ufffd]/;

/** 惰性创建并缓存的内置解码器；取不到编码支持时为 undefined（只试一次）。 */
let builtinDecoder: LegacyDecoder | undefined;
let builtinDecoderResolved = false;

/**
 * 内置解码器：`new TextDecoder('gbk')` 在缺少编码支持的运行时（部分精简 ICU 的构建）
 * 会直接抛异常，所以这里用 try/catch 包住，并且只尝试一次、把结果缓存下来。
 */
function getBuiltinDecoder(): LegacyDecoder | undefined {
  if (builtinDecoderResolved) return builtinDecoder;
  builtinDecoderResolved = true;
  try {
    const decoder = new TextDecoder('gbk');
    builtinDecoder = (bytes) => decoder.decode(bytes);
  } catch {
    builtinDecoder = undefined;
  }
  return builtinDecoder;
}

/** 判断字符串是否呈现"latin1 解码出来的字节"的形态。 */
export function looksLikeLatin1Bytes(value: string): boolean {
  if (value.length === 0) return false;
  // 控制字符说明这不是"整串字节被 latin1 解出来"的形态，直接排除。
  if (CONTROL_OR_REPLACEMENT_PATTERN.test(value)) return false;
  // 已经含汉字，说明这串文本本来就是正常解码的，不存在 GBK 乱码。
  if (hasCjk(value)) return false;
  let highBytes = 0;
  let nonAscii = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) continue;
    nonAscii += 1;
    if (code <= 0xff) highBytes += 1;
  }
  if (highBytes < MIN_HIGH_BYTES) return false;
  return highBytes >= nonAscii * MIN_HIGH_RATIO;
}

/** 把字符串按 latin1 还原成字节（每个码位取低 8 位）。 */
export function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    // 按 UTF-16 码元逐个取低 8 位：真实的乱码字符串全部落在 U+00FF 以内，
    // 每个码元恰好对应一个字节；即便传进来一个码位大于 0xFF 的字符，
    // 这里也只是取它码元的低 8 位——正是约定里的"取低 8 位"。
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** 结果里是否含 CJK 汉字（U+4E00–U+9FFF 及扩展 A U+3400–U+4DBF）。 */
export function hasCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}

/**
 * 尝试修正 GBK 乱码。判定不成立或修正结果不可信时，**原样返回输入**。
 * @param value 可能是乱码的字符串（undefined 原样返回）
 * @param decode 注入的解码器；不传时用内置的 TextDecoder('gbk')，取不到就放弃修正
 */
export function fixGbkMojibake(value: string | undefined, decode?: LegacyDecoder): string | undefined {
  if (!value) return value;
  if (!looksLikeLatin1Bytes(value)) return value;

  const decodeBytes = decode ?? getBuiltinDecoder();
  if (!decodeBytes) return value;

  let decoded: string | undefined;
  try {
    decoded = decodeBytes(latin1ToBytes(value));
  } catch {
    // 解码器抛异常（编码不支持、字节序列非法）时保守放弃。
    return value;
  }

  if (!decoded || decoded === value) return value;
  // 结果必须是"看起来像人话"的中文：无替换字符、无控制字符、含汉字、长度确实收缩了。
  //
  // 这里没有再要求"CJK 占结果的比例"：老 mp3 的标题里中西混排很常见
  // （`周杰伦 Jay`、`青花瓷 (Live)`），短字符串上任何比例阈值都容易把正确结果拒掉，
  // 而过严的代价是用户继续看到乱码、过松的代价是改错——两者都不可接受，
  // 所以宁可用"必须含 CJK"这条硬门槛，把"结果是否可信"的判断留给前两项。
  if (CONTROL_OR_REPLACEMENT_PATTERN.test(decoded)) return value;
  if (!hasCjk(decoded)) return value;
  if (decoded.length > value.length * MAX_RESULT_RATIO) return value;

  return decoded;
}
