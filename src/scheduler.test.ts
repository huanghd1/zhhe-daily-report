import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextRunAt, scheduleDaily } from './scheduler.js';

// 均使用本地时间构造，测试结果与运行机器的时区无关
describe('nextRunAt', () => {
  it('returns today 08:00 when it is still before 08:00', () => {
    expect(nextRunAt(8, 0, new Date(2026, 10, 6, 7, 59, 30))).toEqual(new Date(2026, 10, 6, 8, 0));
  });

  it('returns tomorrow 08:00 at or after 08:00', () => {
    expect(nextRunAt(8, 0, new Date(2026, 10, 6, 8, 0, 0))).toEqual(new Date(2026, 10, 7, 8, 0));
    expect(nextRunAt(8, 0, new Date(2026, 10, 6, 23, 0))).toEqual(new Date(2026, 10, 7, 8, 0));
  });

  it('rolls over month and year boundaries', () => {
    expect(nextRunAt(8, 0, new Date(2026, 11, 31, 9, 0))).toEqual(new Date(2027, 0, 1, 8, 0));
  });
});

describe('scheduleDaily', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once per day at the given time, keeps going after failures, and stops cleanly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 6, 7, 0));
    const task = vi.fn().mockRejectedValueOnce(new Error('upstream down')).mockResolvedValue(undefined);
    const onError = vi.fn();

    const stop = scheduleDaily(8, 0, task, onError);

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000); // 08:00 第一次执行，失败
    expect(task).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'upstream down' }));

    await vi.advanceTimersByTimeAsync(24 * 3600_000); // 次日 08:00 照常执行
    expect(task).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3 * 24 * 3600_000);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
