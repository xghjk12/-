import { describe, expect, it } from 'vitest';
import { formatDate, formatDuration, formatTime, pad2 } from './format.js';

describe('pad2', () => {
  it('小于 10 补零，其余原样', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(5)).toBe('05');
    expect(pad2(9)).toBe('09');
    expect(pad2(10)).toBe('10');
    expect(pad2(59)).toBe('59');
  });
});

describe('formatTime', () => {
  it('输出 m:ss 与 h:mm:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(59)).toBe('0:59');
    expect(formatTime(59.9)).toBe('0:59');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(245)).toBe('4:05');
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3725)).toBe('1:02:05');
  });

  it('非法输入一律归零，不产生 NaN', () => {
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
    expect(formatTime(-Infinity)).toBe('0:00');
    expect(formatTime(undefined)).toBe('0:00');
    expect(formatTime(null as unknown as number)).toBe('0:00');
    expect(formatTime('abc' as unknown as number)).toBe('0:00');
  });

  it('数值字符串按数字处理', () => {
    expect(formatTime('245' as unknown as number)).toBe('4:05');
  });

  it('跨过小时边界时分钟仍然补零', () => {
    expect(formatTime(3599)).toBe('59:59');
    expect(formatTime(3601)).toBe('1:00:01');
    expect(formatTime(3600 * 10 + 65)).toBe('10:01:05');
  });
});

describe('formatDuration', () => {
  it('用于曲库统计', () => {
    expect(formatDuration(0)).toBe('0 分钟');
    expect(formatDuration(2880)).toBe('48 分钟');
    expect(formatDuration(11520)).toBe('3 小时 12 分');
  });

  it('不足一分钟与不足一小时的表现', () => {
    expect(formatDuration(59)).toBe('0 分钟');
    expect(formatDuration(3599)).toBe('59 分钟');
    expect(formatDuration(3600)).toBe('1 小时 0 分');
  });

  it('非法输入归零', () => {
    expect(formatDuration(undefined)).toBe('0 分钟');
    expect(formatDuration(NaN)).toBe('0 分钟');
    expect(formatDuration(-100)).toBe('0 分钟');
    expect(formatDuration(Infinity)).toBe('0 分钟');
    expect(formatDuration(-Infinity)).toBe('0 分钟');
    expect(formatDuration('abc' as unknown as number)).toBe('0 分钟');
  });
});

describe('formatDate', () => {
  it('按本地时区输出日期', () => {
    const noon = new Date(2026, 0, 20, 12, 0, 0).getTime();
    expect(formatDate(noon)).toBe('2026/01/20');
  });

  it('月与日补零', () => {
    expect(formatDate(new Date(2026, 8, 5, 9, 0, 0).getTime())).toBe('2026/09/05');
  });

  it('非法输入返回破折号', () => {
    expect(formatDate('不是时间' as unknown as number)).toBe('—');
    expect(formatDate('' as unknown as number)).toBe('—');
    expect(formatDate('   ' as unknown as number)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate(null as unknown as number)).toBe('—');
    expect(formatDate(NaN)).toBe('—');
  });

  it('epoch 与 0 是合法时间戳', () => {
    const epoch = new Date(0);
    expect(formatDate(0)).toBe(
      `${epoch.getFullYear()}/${pad2(epoch.getMonth() + 1)}/${pad2(epoch.getDate())}`,
    );
  });
});
