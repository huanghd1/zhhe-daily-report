// 原生定时任务：每天在服务器本地时间 hour:minute 执行一次，不依赖 node-cron

// 计算 from 之后（严格晚于）最近一次 hour:minute；按本地日历推进，跨夏令时也落在正确的钟点
export function nextRunAt(hour: number, minute: number, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

// 每次执行完再重新计算下一次时间，避免 setInterval 的累计漂移；返回停止函数
export function scheduleDaily(
  hour: number,
  minute: number,
  task: () => Promise<unknown>,
  onError: (err: unknown) => void = (err) => console.error('定时任务失败：', err),
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    const delay = nextRunAt(hour, minute).getTime() - Date.now();
    timer = setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        onError(err);
      }
      arm();
    }, delay);
  };

  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
