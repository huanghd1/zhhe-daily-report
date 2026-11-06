import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// 用户表：自增 id、用户名、邮箱、创建时间（由数据库填充当前时间）
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// GitHub 榜单条目；stars 统一存数字（上游可能给 "17,010" 这样的字符串）
export interface TrendingRepo {
  name: string; // owner/repo
  description: string;
  stars: number;
  language: string | null;
  url: string;
}

// AI 快讯条目；source 为文章链接的域名
export interface NewsItem {
  title: string;
  url: string;
  source: string;
}

// 每日简报：每天一条，date 唯一；榜单与快讯以 JSON 字符串存储，读写时由 Drizzle 自动序列化
export const dailyReports = sqliteTable('daily_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(), // 服务器本地日期，如 2026-11-06
  githubTrending: text('github_trending', { mode: 'json' }).$type<TrendingRepo[]>().notNull(),
  aiNews: text('ai_news', { mode: 'json' }).$type<NewsItem[]>().notNull(),
  aiAnalysis: text('ai_analysis').notNull(),
  // 榜单来源：trending = isboyjc 每日榜单，search = 其过期时降级到 GitHub Search API
  githubSource: text('github_source', { enum: ['trending', 'search'] }).notNull(),
  githubDataDate: text('github_data_date').notNull(), // 榜单数据本身的日期
  generatedAt: integer('generated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type DailyReport = typeof dailyReports.$inferSelect;
