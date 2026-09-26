/**
 * 展示用的文本格式化：时长、总时长、日期。纯逻辑，不引用任何平台 API。
 *
 * 放在 core 而不是界面层，是因为这些函数每条都要被列表里的每一行调用：
 * 元数据缺失、文件损坏、时长为 0 都会把 `NaN` 送进来，如果没有统一归零，
 * 界面上就会出现"NaN:NaN"。这里对所有非法输入都返回一个可读的兜底值。
 */

/** 两位补零。负数与 NaN 不在本函数的职责范围内，调用方已先归零。 */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 秒 -> "3:45" / "1:02:05"；非法输入一律归零。 */
export function formatTime(seconds?: number): string {
  let total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total < 0) total = 0;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  // 只有真的超过一小时才显示小时位，否则列表里一排 "0:03:45" 太吵
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(rest)}`
    : `${minutes}:${pad2(rest)}`;
}

/** 秒 -> "3 小时 12 分" / "48 分钟"，用于曲库统计。 */
export function formatDuration(seconds?: number): string {
  const value = Number(seconds);
  // 先夹掉 NaN / ±Infinity（`Math.floor(Infinity)` 仍是 Infinity，会渲染出"Infinity 小时 NaN 分"）
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

/**
 * 把入参收敛成毫秒时间戳；无法视为时间的返回 null。
 *
 * 比 Demo 更严的地方：显式拒绝 `null` 与空串。它们会被 `Number()` 静默变成 0，
 * 于是界面上会把「没有入库时间」显示成 1970/01/01，比显示占位符更容易误导用户。
 */
function toTimestamp(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const stamp = Number(value);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * 时间戳 -> "2026/01/01"；非法输入返回 "—"。
 *
 * 用本地时区（`getFullYear` 等）而不是 UTC：曲目入库时间对用户来说就是本地时间，
 * 按 UTC 显示会让"今天添加"的曲目在跨时区时跳到昨天。
 */
export function formatDate(timestamp?: number): string {
  const stamp = toTimestamp(timestamp);
  if (stamp === null) return '—';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
}
