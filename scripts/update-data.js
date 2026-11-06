// 每日简报数据生成脚本：抓 GitHub 榜单和 HN AI 快讯，调用大模型分析，写入 public/data.json。
// 只用 Node 24 原生能力（fetch、node:fs、node:util），没有第三方依赖。
// 本地运行 npm run update（读取根目录 .env）；GitHub Actions 中由 Secrets / Variables 注入环境变量。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * @typedef {{ name: string, description: string, stars: number, language: string | null, url: string }} TrendingRepo
 * @typedef {{ title: string, url: string, source: string }} NewsItem
 * @typedef {{ repos: TrendingRepo[], source: 'trending' | 'search', dataDate: string }} GithubResult
 * @typedef {{ apiKey: string, baseUrl: string, model: string }} LlmConfig
 * @typedef {'config' | 'github' | 'news' | 'llm'} ReportStage
 */

// 脚本位于 scripts/，上一级即项目根目录，与启动命令所在目录无关
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ENV_PATH = join(PROJECT_ROOT, '.env');
export const DATA_PATH = join(PROJECT_ROOT, 'public', 'data.json');

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

const FETCH_TIMEOUT_MS = 15_000;
// 推理类模型会先输出思考过程，耗时较长
const LLM_TIMEOUT_MS = 120_000;
// isboyjc 数据超过这个时长视为过期
const TRENDING_MAX_AGE_MS = 48 * 3600_000;
const TOP_REPOS = 5;
const TOP_NEWS = 5;
const USER_AGENT = 'zhhe-reonr-daily-report';
// 简报按北京时间归档；中国不实行夏令时，固定 UTC+8，不依赖运行环境的时区设置
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** @param {string} title */
export function isFinanceTitle(title) {
  return FINANCE_TITLE_PATTERN.test(title);
}

// 带阶段信息的错误，失败时打印是哪一步出的问题
export class ReportError extends Error {
  /**
   * @param {ReportStage} stage
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(stage, message, options) {
    super(message, options);
    this.name = 'ReportError';
    /** @type {ReportStage} */
    this.stage = stage;
  }
}

// 北京时间日期（YYYY-MM-DD）。定时任务在北京时间 08:00 运行，简报归档到当天
export function beijingDate(now = new Date()) {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 统一的 fetch + 超时 + 状态码检查，失败时包装为对应阶段的 ReportError
 * @param {ReportStage} stage
 * @param {string} url
 * @param {number} timeoutMs
 * @param {RequestInit} [init]
 * @returns {Promise<unknown>}
 */
async function fetchJson(stage, url, timeoutMs, init = {}) {
  const host = new URL(url).host;
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ReportError(stage, `请求失败：${host}（${/** @type {Error} */ (err).message}）`, { cause: err });
  }
  if (!res.ok) {
    // 附带一小段响应体（如大模型返回的 "invalid api key"），方便排查；不会包含请求头里的 key
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new ReportError(stage, `请求失败：${host} 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ReportError(stage, `响应不是合法 JSON：${host}`, { cause: err });
  }
}

// "17,010" / 17010 / "1.2k" → 数字；无法解析时返回 0
/** @param {unknown} value */
export function parseStars(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value !== 'string') return 0;
  const s = value.trim().toLowerCase().replace(/,/g, '');
  const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!match) return 0;
  return Math.round(Number(match[1]) * (match[2] ? 1000 : 1));
}

// 外部链接只接受 http/https，防止 javascript: 等协议进入页面
/** @param {unknown} value */
export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

// ---------- GitHub ----------

/**
 * @param {unknown} raw
 * @param {{ name: string, url: string, stars: string }} keys
 * @returns {TrendingRepo | null}
 */
function toRepo(raw, keys) {
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

/**
 * isboyjc 榜单：数据新鲜时返回结果，过期或格式异常时返回 null（交给降级逻辑）
 * @param {Date} now
 * @returns {Promise<GithubResult | null>}
 */
async function fetchTrendingFeed(now) {
  const data = asRecord(await fetchJson('github', TRENDING_URL, FETCH_TIMEOUT_MS));
  const pubDate = new Date(str(data.pubDate));
  if (Number.isNaN(pubDate.getTime()) || now.getTime() - pubDate.getTime() > TRENDING_MAX_AGE_MS) {
    return null;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = items
    .map((it) => toRepo(it, { name: 'title', url: 'url', stars: 'stars' }))
    .filter((r) => r !== null)
    .slice(0, TOP_REPOS);
  if (repos.length === 0) return null;
  return { repos, source: 'trending', dataDate: beijingDate(pubDate) };
}

/**
 * 降级方案：近 7 天新建、按 star 排序的仓库（"近期热门新项目"，与官方 Trending 口径不同）。
 * Actions 的出口 IP 是共享的，匿名请求 Search API 每分钟只有 10 次，容易被限流，所以有 GITHUB_TOKEN 时带上它
 * @param {Date} now
 * @param {string | undefined} token
 * @returns {Promise<GithubResult>}
 */
async function fetchSearchFallback(now, token) {
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    q: `created:>=${since}`,
    sort: 'stars',
    order: 'desc',
    per_page: String(TOP_REPOS),
  });
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = asRecord(await fetchJson('github', `${GITHUB_SEARCH_URL}?${params}`, FETCH_TIMEOUT_MS, { headers }));
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = items
    .map((it) => toRepo(it, { name: 'full_name', url: 'html_url', stars: 'stargazers_count' }))
    .filter((r) => r !== null)
    .slice(0, TOP_REPOS);
  if (repos.length === 0) {
    throw new ReportError('github', 'GitHub Search API 未返回任何仓库');
  }
  return { repos, source: 'search', dataDate: beijingDate(now) };
}

/**
 * @param {Date} [now]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<GithubResult>}
 */
export async function fetchGithubTrending(now = new Date(), env = process.env) {
  try {
    const fresh = await fetchTrendingFeed(now);
    if (fresh) return fresh;
  } catch {
    // isboyjc 不可用时同样走降级，只有两个来源都失败才报错
  }
  return fetchSearchFallback(now, env.GITHUB_TOKEN?.trim() || undefined);
}

// ---------- AI 快讯（Hacker News）----------

/** @param {string} url */
function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * 过去 24 小时标题含任一关键词的 HN 帖子，按点赞数取前 TOP_NEWS 条；Ask HN 等无外链的帖子指向 HN 讨论页
 * @param {Date} [now]
 * @returns {Promise<NewsItem[]>}
 */
export async function fetchAiNews(now = new Date()) {
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

  const seen = new Set();
  /** @type {NewsItem[]} */
  const news = [];
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

/**
 * 读取 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，缺失或格式不对时报 config 错误
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {LlmConfig}
 */
export function readLlmConfig(env = process.env) {
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  const missing = [!apiKey && 'LLM_API_KEY', !baseUrl && 'LLM_BASE_URL', !model && 'LLM_MODEL'].filter(Boolean);
  if (!apiKey || !baseUrl || !model) {
    throw new ReportError(
      'config',
      `未配置 ${missing.join('、')}：本地请写入 .env（参考 .env.example），GitHub Actions 请在仓库 Secrets / Variables 中配置`,
    );
  }
  if (!safeUrl(baseUrl)) {
    throw new ReportError('config', 'LLM_BASE_URL 必须是 http(s) 地址，例如 https://api.deepseek.com');
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

/**
 * @param {TrendingRepo[]} repos
 * @param {NewsItem[]} news
 */
export function buildPrompt(repos, news) {
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

/**
 * @param {string} prompt
 * @param {LlmConfig} config
 * @returns {Promise<string>}
 */
export async function generateAnalysis(prompt, config) {
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
  // 只取最终答案 content；推理模型的 reasoning_content 不写入
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const content = str(asRecord(asRecord(choices[0]).message).content);
  if (!content) {
    throw new ReportError('llm', '大模型返回内容为空');
  }
  return content;
}

// ---------- .env 读取（仅本地运行时使用）----------

// 兼容 Windows 上常见的保存格式：UTF-8 带 BOM、UTF-16 LE/BE（记事本“Unicode”）。
// process.loadEnvFile 遇到 BOM 会丢掉第一行，遇到 UTF-16 会整个文件读不出来
/** @param {Buffer} buf */
export function decodeEnvFile(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 读取 .env 写入 env；已有非空的环境变量优先，不被文件覆盖。文件不存在时（如 GitHub Actions）直接跳过
 * @param {string} [path]
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ path: string, found: boolean, keys: string[] }} keys 只含变量名，不含值
 */
export function loadEnvFile(path = ENV_PATH, env = process.env) {
  if (!existsSync(path)) {
    return { path, found: false, keys: [] };
  }
  const parsed = parseEnv(decodeEnvFile(readFileSync(path)));
  for (const [key, value] of Object.entries(parsed)) {
    if (!env[key]) env[key] = value;
  }
  return { path, found: true, keys: Object.keys(parsed) };
}

// ---------- 生成与写入 ----------

/**
 * 抓取并分析，返回写入 data.json 的完整内容；任一步失败都会抛出 ReportError
 * @param {Date} [now]
 * @param {Record<string, string | undefined>} [env]
 */
export async function buildReport(now = new Date(), env = process.env) {
  // 先检查配置，缺 key 时不必发起任何外部请求
  const llm = readLlmConfig(env);
  // 日期在开始时确定，跨零点执行也记在发起当天
  const date = beijingDate(now);
  const [github, news] = await Promise.all([fetchGithubTrending(now, env), fetchAiNews(now)]);
  const analysis = await generateAnalysis(buildPrompt(github.repos, news), llm);
  return {
    date,
    githubTrending: github.repos,
    aiNews: news,
    aiAnalysis: analysis,
    githubSource: github.source,
    githubDataDate: github.dataDate,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 先写临时文件再改名覆盖，写到一半出错也不会留下损坏的 data.json
 * @param {unknown} report
 * @param {string} [path]
 */
export function writeReport(report, path = DATA_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * 全部成功后才写文件；失败时保留上一份 data.json，页面继续显示旧简报
 * @param {{ now?: Date, env?: Record<string, string | undefined>, path?: string }} [options]
 */
export async function updateData({ now = new Date(), env = process.env, path = DATA_PATH } = {}) {
  const report = await buildReport(now, env);
  writeReport(report, path);
  return report;
}

async function main() {
  const envFile = loadEnvFile();
  // 只打印变量名，不打印值；.env 没保存或放错位置时一眼就能看出来
  console.log(
    envFile.found
      ? `已读取 .env：${envFile.keys.length ? envFile.keys.join(', ') : '（没有任何变量）'}`
      : '未找到 .env，仅使用系统环境变量',
  );
  const report = await updateData();
  console.log(
    `已写入 ${relative(PROJECT_ROOT, DATA_PATH)}：${report.date}，` +
      `GitHub ${report.githubSource === 'search' ? '近 7 天新项目' : 'Trending'} ${report.githubTrending.length} 个，` +
      `AI 快讯 ${report.aiNews.length} 条，分析 ${report.aiAnalysis.length} 字`,
  );
}

// 直接运行时执行；被测试导入时不执行
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof ReportError ? `生成失败（${err.stage}）：${err.message}` : err);
    process.exitCode = 1;
  });
}
