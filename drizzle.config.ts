import { defineConfig } from 'drizzle-kit';

// 迁移文件输出到 drizzle/ 目录，数据库地址从环境变量读取
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/app.db',
  },
});
