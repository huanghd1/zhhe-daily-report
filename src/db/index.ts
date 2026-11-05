import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

// 数据库地址从环境变量读取，未设置时使用本地 SQLite 文件
const url = process.env.DATABASE_URL ?? 'file:./data/app.db';

export const db = drizzle({ connection: { url }, schema });
