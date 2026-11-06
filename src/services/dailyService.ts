import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from '../db/schema.js';
import { dailyReports, type DailyReport, type NewsItem, type TrendingRepo } from '../db/schema.js';

type Db = LibSQLDatabase<typeof schema>;

// isboyjc 每日榜单（2026-08 起已停更，过期时自动降级到 GitHub Search API）
export const TRENDING_URL = 'https://raw.githubusercontent.com/isboyjc/github-trending-api/main/data/daily/all.json';
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
// HN 官方 Algolia 搜索接口；hnrss.org 实测不稳定，Anthropic 官网没有 RSS
const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HN_KEYWORDS = 'AI LLM Claude Anthropic';
// 纯财经新闻（股市、IPO、估值等）与“前沿技术动态”无关，标题命中任一词即丢弃。
// 按整词匹配（允许复数），避免误伤 marketplace、Stockfish 这类技术词；不收 shares 等常见动词，免得误删产品新闻
const FINANCE_TITLE_PATTERN =
  /\b(?:stocks?|ipos?|nasdaq|markets?|investors?|valuations?|wall street|sell-?offs?)\b/i;

export function isFinanceTitle(title: string): boolean {
  return FINANCE_TITLE_PATTERN.test(title);
}

const FETCH_TIMEOUT_MS = 15_000;
// 推理类模型（如 kimi-k3.1-pro）会先输出思考过程，耗时较长
const LLM_TIMEOUT_MS = 120_000;
// isboyjc 数据超过这个时长视为过期
const TRENDING_MAX_AGE_MS = 48 * 3600_000;
const TOP_REPOS = 5;
const TOP_NEWS = 5;
const USER_AGENT = 'zhhe-reonr-daily-report';

export type ReportStage = 'config' | 'github' | 'news' | 'llm';

// 带阶段信息的错误，路由据此返回 502 / 503 并告诉调用方哪一步失败
export class ReportError extends Error {
  readonly stage: ReportStage;

  constructor(stage: ReportStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReportError';
    this.stage = stage;
  }
}

// 服务器本地日期（YYYY-MM-DD），与 08:00 定时任务使用同一时区
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 统一的 fetch + 超时 + 状态码检查，失败时包装为对应阶段的 ReportError
async function fetchJson(stage: ReportStage, url: string, timeoutMs: number, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ReportError(stage, `请求失败：${new URL(url).host}（${(err as Error).message}）`, { cause: err });
  }
  if (!res.ok) {
    // 附带一小段响应体（如大模型返回的 "invalid api key"），方便排查；不会包含请求里的 key
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new ReportError(stage, `请求失败：${new URL(url).host} 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ReportError(stage, `响应不是合法 JSON：${new URL(url).host}`, { cause: err });
  }
}

// "17,010" / 17010 / "1.2k" → 数字；无法解析时返回 0
export function parseStars(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value !== 'string') return 0;
  const s = value.trim().toLowerCase().replace(/,/g, '');
  const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!match) return 0;
  const n = Number(match[1]) * (match[2] ? 1000 : 1);
  return Math.round(n);
}

// 外部链接只接受 http/https，防止 javascript: 等协议进入页面
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// ---------- GitHub ----------

export interface GithubResult {
  repos: TrendingRepo[];
  source: 'trending' | 'search';
  dataDate: string; // 榜单数据本身对应的日期
}

function toRepo(raw: unknown, keys: { name: string; url: string; stars: string }): TrendingRepo | null {
  const r = asRecord(raw);
  const name = str(r[keys.name]);
  const url = safeUrl(r[keys.url]);
  if (!name || !url) return null;
  return {
    name,
    description: str(r.description),
    stars: parseStars(r[keys.stars]),
    language: str(r.language) || null,
    url,
  };
}

// isboyjc 榜单：数据新鲜时返回结果，过期或格式异常时返回 null（交给降级逻辑）
async function fetchTrendingFeed(now: Date): Promise<GithubResult | null> {
  const data = asRecord(await fetchJson('github', TRENDING_URL, FETCH_TIMEOUT_MS));
  const pubDate = new Date(str(data.pubDate));
  if (Number.isNaN(pubDate.getTime()) || now.getTime() - pubDate.getTime() > TRENDING_MAX_AGE_MS) {
    return null;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = items
    .map((it) => toRepo(it, { name: 'title', url: 'url', stars: 'stars' }))
    .filter((r): r is TrendingRepo => r !== null)
    .slice(0, TOP_REPOS);
  if (repos.length === 0) return null;
  return { repos, source: 'trending', dataDate: localDate(pubDate) };
}

// 降级方案：近 7 天新建、按 star 排序的仓库（"近期热门新项目"，与官方 Trending 口径不同）
async function fetchSearchFallback(now: Date): Promise<GithubResult> {
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    q: `created:>=${since}`,
    sort: 'stars',
    order: 'desc',
    per_page: String(TOP_REPOS),
  });
  const data = asRecord(
    await fetchJson('github', `${GITHUB_SEARCH_URL}?${params}`, FETCH_TIMEOUT_MS, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    }),
  );
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = items
    .map((it) => toRepo(it, { name: 'full_name', url: 'html_url', stars: 'stargazers_count' }))
    .filter((r): r is TrendingRepo => r !== null)
    .slice(0, TOP_REPOS);
  if (repos.length === 0) {
    throw new ReportError('github', 'GitHub Search API 未返回任何仓库');
  }
  return { repos, source: 'search', dataDate: localDate(now) };
}

export async function fetchGithubTrending(now: Date = new Date()): Promise<GithubResult> {
  try {
    const fresh = await fetchTrendingFeed(now);
    if (fresh) return fresh;
  } catch {
    // isboyjc 不可用时同样走降级，只有两个来源都失败才报错
  }
  return fetchSearchFallback(now);
}

// ---------- AI 快讯（Hacker News）----------

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

// 过去 24 小时标题含任一关键词的 HN 帖子，按点赞数取前 TOP_NEWS 条；Ask HN 等无外链的帖子指向 HN 讨论页
export async function fetchAiNews(now: Date = new Date()): Promise<NewsItem[]> {
  const since = Math.floor(now.getTime() / 1000) - 86400;
  const params = new URLSearchParams({
    query: HN_KEYWORDS,
    optionalWords: HN_KEYWORDS, // 关键词之间是 OR 关系
    restrictSearchableAttributes: 'title',
    tags: 'story',
    numericFilters: `created_at_i>${since}`,
    hitsPerPage: '50',
    attributesToRetrieve: 'title,url,points,objectID',
  });
  const data = asRecord(await fetchJson('news', `${HN_SEARCH_URL}?${params}`, FETCH_TIMEOUT_MS));
  const hits = (Array.isArray(data.hits) ? data.hits : [])
    .map(asRecord)
    .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));

  const seen = new Set<string>();
  const news: NewsItem[] = [];
  for (const hit of hits) {
    const title = str(hit.title);
    const id = str(hit.objectID);
    const url = safeUrl(hit.url) ?? (/^\d+$/.test(id) ? `https://news.ycombinator.com/item?id=${id}` : null);
    // 同一篇文章常被多人重复提交，按标题去重
    const key = title.toLowerCase();
    if (!title || !url || seen.has(key) || isFinanceTitle(title)) continue;
    seen.add(key);
    news.push({ title, url, source: hostOf(url) });
    if (news.length === TOP_NEWS) break;
  }
  if (news.length === 0) {
    throw new ReportError('news', 'Hacker News 过去 24 小时没有匹配的 AI 帖子');
  }
  return news;
}

// ---------- 大模型分析（OpenAI 兼容协议）----------

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

// 读取 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL；缺失时只让生成接口报错，不影响服务启动
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  const missing = [!apiKey && 'LLM_API_KEY', !baseUrl && 'LLM_BASE_URL', !model && 'LLM_MODEL'].filter(Boolean);
  if (missing.length > 0) {
    throw new ReportError('config', `未配置 ${missing.join('、')}，请在 .env 中填写（参考 .env.example）`);
  }
  if (!safeUrl(baseUrl)) {
    throw new ReportError('config', 'LLM_BASE_URL 必须是 http(s) 地址，例如 https://api.deepseek.com');
  }
  return { apiKey: apiKey!, baseUrl: baseUrl!.replace(/\/+$/, ''), model: model! };
}

export function buildPrompt(repos: TrendingRepo[], news: NewsItem[]): string {
  const repoLines = repos.map(
    (r, i) => `${i + 1}. ${r.name}（${r.language ?? '未知语言'}，${r.stars} stars）：${r.description || '无描述'}`,
  );
  const newsLines = news.map((n, i) => `${i + 1}. ${n.title}（来源：${n.source}）`);
  return [
    '以下是今天的 GitHub 热门项目和 AI 领域动态：',
    '',
    '【GitHub 热门项目】',
    ...repoLines,
    '',
    '【AI 前沿动态】',
    ...newsLines,
    '',
    '请写一段约 300 字的中文“今日技术趋势与解读”：提炼共同趋势，点评一两个值得关注的项目或事件，',
    '最后给开发者一条实用建议。只输出正文，不要标题、列表或 Markdown 格式。',
  ].join('\n');
}

export async function generateAnalysis(prompt: string, config: LlmConfig): Promise<string> {
  const data = asRecord(
    await fetchJson('llm', `${config.baseUrl}/chat/completions`, LLM_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一名资深技术分析师，擅长用简洁的中文解读开源与 AI 趋势。' },
          { role: 'user', content: prompt },
        ],
      }),
    }),
  );
  // 只取最终答案 content；推理模型的 reasoning_content 不入库
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const content = str(asRecord(asRecord(choices[0]).message).content);
  if (!content) {
    throw new ReportError('llm', '大模型返回内容为空');
  }
  return content;
}

// ---------- 生成与读取 ----------

// 同一个库、同一天的生成任务只跑一次：手动触发与定时任务撞车时共用结果，避免重复调用大模型
const inFlight = new WeakMap<Db, Map<string, Promise<DailyReport>>>();

async function runGeneration(db: Db, date: string, now: Date): Promise<DailyReport> {
  // 先检查配置，缺 key 时不必发起任何外部请求
  const llm = readLlmConfig();
  const [github, news] = await Promise.all([fetchGithubTrending(now), fetchAiNews(now)]);
  const analysis = await generateAnalysis(buildPrompt(github.repos, news), llm);

  // 全部成功后才写库；同一天重复生成时覆盖当天记录
  const fields = {
    githubTrending: github.repos,
    aiNews: news,
    aiAnalysis: analysis,
    githubSource: github.source,
    githubDataDate: github.dataDate,
    generatedAt: new Date(),
  };
  const [row] = await db
    .insert(dailyReports)
    .values({ date, ...fields })
    .onConflictDoUpdate({ target: dailyReports.date, set: fields })
    .returning();
  return row;
}

export function generateDailyReport(db: Db, now: Date = new Date()): Promise<DailyReport> {
  // 日期在开始时确定，跨零点执行也记在发起当天
  const date = localDate(now);
  const byDate = inFlight.get(db) ?? new Map<string, Promise<DailyReport>>();
  inFlight.set(db, byDate);
  const pending = byDate.get(date);
  if (pending) return pending;

  const task = runGeneration(db, date, now).finally(() => byDate.delete(date));
  byDate.set(date, task);
  return task;
}

export async function getReportByDate(db: Db, date: string): Promise<DailyReport | undefined> {
  return db.select().from(dailyReports).where(eq(dailyReports.date, date)).get();
}
