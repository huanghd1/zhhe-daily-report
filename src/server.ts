// 必须先于 db 模块加载，否则 DATABASE_URL 读取不到 .env 中的值
import './load-env.js';
import { buildApp } from './app.js';
import { db } from './db/index.js';

// 端口和地址从环境变量读取，未设置时使用默认值
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({ db });

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
