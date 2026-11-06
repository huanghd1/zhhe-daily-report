// 必须先于 db 模块加载，否则 DATABASE_URL 读取不到 .env 中的值
import './load-env.js';
import { buildApp } from './app.js';
import { db } from './db/index.js';
import { nextRunAt, scheduleDaily } from './scheduler.js';
import { generateDailyReport, readLlmConfig } from './services/dailyService.js';

// 端口和地址从环境变量读取，未设置时使用默认值
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

// 启动前检查必填变量，缺失时给出明确提示并退出，而不是无声失败
if (!process.env.AUTH_TOKEN) {
  console.error('启动失败：未读取到 AUTH_TOKEN，请在根目录 .env 中设置，例如 AUTH_TOKEN=your-token');
  process.exit(1);
}

const app = buildApp({ db });

try {
  await app.listen({ port, host });
  console.log(`Server listening on http://localhost:${port}`);
} catch (err) {
  // app 使用 logger: false，app.log 不输出任何内容，这里必须直接写 stderr，否则端口占用等错误会静默退出
  console.error('启动失败：', err);
  process.exit(1);
}

// LLM 配置缺失不阻止启动（/users 等接口照常可用），只提示简报生成会失败
try {
  readLlmConfig();
} catch (err) {
  console.warn(`提示：${(err as Error).message}；在此之前每日简报无法生成`);
}

// 每天服务器本地时间 08:00 自动生成简报；失败只记录日志，第二天照常执行
scheduleDaily(8, 0, async () => {
  const report = await generateDailyReport(db);
  console.log(`每日简报已生成：${report.date}`);
});
console.log(`每日简报定时任务已启动，下次执行：${nextRunAt(8, 0).toLocaleString()}`);
