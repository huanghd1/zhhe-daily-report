import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  beijingDate,
  buildPrompt,
  DATA_PATH,
  decodeEnvFile,
  ENV_PATH,
  extractKeywords,
  fetchAiNews,
  fetchGithubTrending,
  fillStarDeltas,
  generateAnalysis,
  isFinanceTitle,
  loadEnvFile,
  parseStars,
  readLlmConfig,
  ReportError,
  safeUrl,
  TRENDING_URL,
  updateData,
} from './update-data.js';

const NOW = new Date('2026-11-06T00:30:00Z');
const SEARCH_URL = 'https://api.github.com/search/repositories';
const HN_URL = 'https://hn.algolia.com/api/v1/search';
const LLM_ENV = { LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://llm.test/v1', LLM_MODEL: 'test-model' };

const dir = mkdtempSync(join(tmpdir(), 'update-data-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 按 URL 前缀路由的 fetch 替身；值为函数时可根据请求动态返回，返回 Response 时原样使用
function mockFetch(routes) {
  const fn = vi.fn(async (input, init) => {
    const url = String(input);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const handler = routes[key];
    const body = typeof handler === 'function' ? await handler(url, init) : handler;
    return body instanceof Response ? body : Response.json(body);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function trendingItem(i, extra = {}) {
  return {
    title: `owner/repo-${i}`,
    url: `https://github.com/owner/repo-${i}`,
    description: `desc ${i}`,
    language: 'TypeScript',
    stars: `${i},000`,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStars', () => {
  it('parses comma-separated strings, numbers and k suffix', () => {
    expect(parseStars('17,010')).toBe(17010);
    expect(parseStars(523)).toBe(523);
    expect(parseStars('1.2k')).toBe(1200);
    expect(parseStars(' 42 ')).toBe(42);
  });

  it('returns 0 for unparseable values', () => {
    expect(parseStars('abc')).toBe(0);
    expect(parseStars(undefined)).toBe(0);
    expect(parseStars(Number.NaN)).toBe(0);
  });
});

describe('safeUrl', () => {
  it('accepts http(s) and rejects other protocols', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(123)).toBeNull();
  });
});

describe('beijingDate', () => {
  it('uses UTC+8 regardless of the machine time zone', () => {
    // UTC 00:00 = 北京 08:00，也就是定时任务的运行时刻
    expect(beijingDate(new Date('2026-11-06T00:00:00Z'))).toBe('2026-11-06');
    expect(beijingDate(new Date('2026-11-05T15:59:59Z'))).toBe('2026-11-05');
    expect(beijingDate(new Date('2026-11-05T16:00:00Z'))).toBe('2026-11-06');
  });
});

describe('fetchGithubTrending', () => {
  it('uses the isboyjc feed when it is fresh, taking the top 5 with numeric stars', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [1, 2, 3, 4, 5, 6].map((i) => trendingItem(i)),
      },
    });

    const result = await fetchGithubTrending(NOW, {});

    expect(result.source).toBe('trending');
    expect(result.dataDate).toBe('2026-11-05');
    expect(result.repos).toHaveLength(5);
    expect(result.repos[0]).toEqual({
      name: 'owner/repo-1',
      description: 'desc 1',
      stars: 1000,
      addStars: 0,
      language: 'TypeScript',
      languageColor: '#3178c6',
      url: 'https://github.com/owner/repo-1',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the feed addStars and a valid languageColor, rejecting unsafe colors', async () => {
    mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [
          trendingItem(1, { addStars: '1,002', language: 'HTML', languageColor: '#e34c26' }),
          trendingItem(2, { language: 'Brainfuck', languageColor: 'red;background:url(x)' }),
        ],
      },
    });

    const [first, second] = (await fetchGithubTrending(NOW, {})).repos;
    expect(first).toMatchObject({ addStars: 1002, languageColor: '#e34c26' });
    // 不在表里的语言、非 hex 颜色都不写入，页面用默认灰色
    expect(second).toMatchObject({ addStars: 0, languageColor: null });
  });

  it('falls back to the GitHub Search API when the feed is older than 48h', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: { pubDate: 'Wed, 26 Aug 2026 13:56:53 GMT', items: [trendingItem(1)] },
      [SEARCH_URL]: {
        items: [
          { full_name: 'a/b', html_url: 'https://github.com/a/b', description: null, language: null, stargazers_count: 19525 },
        ],
      },
    });

    const result = await fetchGithubTrending(NOW, {});

    expect(result.source).toBe('search');
    expect(result.dataDate).toBe('2026-11-06');
    // Search API 没有今日增量，addStars 为 null，由 fillStarDeltas 对比上一份 data.json 补齐
    expect(result.repos).toEqual([
      { name: 'a/b', description: '', stars: 19525, addStars: null, language: null, languageColor: null, url: 'https://github.com/a/b' },
    ]);
    const searchUrl = new URL(String(fetchFn.mock.calls[1][0]));
    expect(searchUrl.searchParams.get('q')).toBe('created:>=2026-10-30');
    expect(searchUrl.searchParams.get('sort')).toBe('stars');
    // 没有 GITHUB_TOKEN 时匿名请求
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('sends GITHUB_TOKEN to the Search API when available', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 1 }] },
    });

    await fetchGithubTrending(NOW, { GITHUB_TOKEN: ' ghs_test ' });

    const [, init] = fetchFn.mock.calls.find(([url]) => String(url).startsWith(SEARCH_URL));
    expect(init.headers.Authorization).toBe('Bearer ghs_test');
  });

  it('falls back when the feed request fails', async () => {
    mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 1 }] },
    });

    expect((await fetchGithubTrending(NOW, {})).source).toBe('search');
  });

  it('throws a github-stage error when both sources fail', async () => {
    mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      [SEARCH_URL]: new Response('rate limited', { status: 403 }),
    });

    await expect(fetchGithubTrending(NOW, {})).rejects.toMatchObject({ name: 'ReportError', stage: 'github' });
  });

  it('drops items with unsafe urls', async () => {
    mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [trendingItem(1, { url: 'javascript:alert(1)' }), trendingItem(2)],
      },
    });

    const result = await fetchGithubTrending(NOW, {});
    expect(result.repos.map((r) => r.name)).toEqual(['owner/repo-2']);
  });
});

describe('fetchAiNews', () => {
  it('sorts by points, dedupes titles, links self posts to HN and limits to 5', async () => {
    const fetchFn = mockFetch({
      [HN_URL]: {
        hits: [
          { title: 'Low', url: 'https://www.example.com/low', points: 1, objectID: '1' },
          { title: 'Top story', url: 'https://www.wsj.com/a', points: 469, objectID: '2' },
          { title: 'top story', url: 'https://wsj.com/a-dup', points: 300, objectID: '3' },
          { title: 'Ask HN: agents?', url: null, points: 200, objectID: '4' },
          { title: 'Bad link', url: 'javascript:alert(1)', points: 150, objectID: 'x' },
          { title: 'Four', url: 'https://four.dev', points: 100, objectID: '5' },
          { title: 'Five', url: 'https://five.dev', points: 90, objectID: '6' },
          { title: 'Six', url: 'https://six.dev', points: 80, objectID: '7' },
        ],
      },
    });

    const news = await fetchAiNews(NOW);

    expect(news).toEqual([
      { title: 'Top story', url: 'https://www.wsj.com/a', source: 'wsj.com', points: 469 },
      { title: 'Ask HN: agents?', url: 'https://news.ycombinator.com/item?id=4', source: 'news.ycombinator.com', points: 200 },
      { title: 'Four', url: 'https://four.dev/', source: 'four.dev', points: 100 },
      { title: 'Five', url: 'https://five.dev/', source: 'five.dev', points: 90 },
      { title: 'Six', url: 'https://six.dev/', source: 'six.dev', points: 80 },
    ]);
    // 只查过去 24 小时，关键词之间为 OR
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.searchParams.get('numericFilters')).toBe(`created_at_i>${Math.floor(NOW.getTime() / 1000) - 86400}`);
    expect(url.searchParams.get('optionalWords')).toBe(url.searchParams.get('query'));
  });

  it('throws a news-stage error when nothing matches', async () => {
    mockFetch({ [HN_URL]: { hits: [] } });

    await expect(fetchAiNews(NOW)).rejects.toMatchObject({ stage: 'news' });
  });
});

describe('isFinanceTitle', () => {
  it.each([
    'Nasdaq Sinks 5% as Investors Retreat from AI Trade After Election',
    'Major Investors Are Skeptical Anthropic IPO Can Achieve $1.5T Valuation',
    'AI stock selloffs fuel fears',
    'Wipeout for AI stocks sends Wall Street reeling',
    'AI market cools',
  ])('flags finance headline: %s', (title) => {
    expect(isFinanceTitle(title)).toBe(true);
  });

  it.each([
    'Claude Code sends your email address to websites',
    'Tencent Launches Hy4, One of the Leading Open-Source AI Models',
    'Show HN: An AI agent marketplace',
    'Stockfish-style search for LLM reasoning',
  ])('keeps tech headline: %s', (title) => {
    expect(isFinanceTitle(title)).toBe(false);
  });

  it('drops finance stories from the news list and backfills from the rest', async () => {
    mockFetch({
      [HN_URL]: {
        hits: [
          { title: 'Nasdaq Sinks 5% as Investors Retreat from AI Trade', url: 'https://wsj.com/a', points: 500, objectID: '1' },
          { title: 'Claude Code sends your email address to websites', url: 'https://github.com/x', points: 469, objectID: '2' },
          { title: 'Anthropic IPO valuation doubts', url: 'https://wsj.com/b', points: 300, objectID: '3' },
          { title: 'New open LLM released', url: 'https://example.com/llm', points: 100, objectID: '4' },
        ],
      },
    });

    const news = await fetchAiNews(NOW);

    expect(news.map((n) => n.title)).toEqual(['Claude Code sends your email address to websites', 'New open LLM released']);
  });
});

describe('readLlmConfig', () => {
  it('lists every missing variable', () => {
    expect(() => readLlmConfig({})).toThrow(/LLM_API_KEY、LLM_BASE_URL、LLM_MODEL/);
  });

  it('rejects non-http base urls and trims trailing slashes', () => {
    expect(() => readLlmConfig({ LLM_API_KEY: 'k', LLM_BASE_URL: 'ftp://x', LLM_MODEL: 'm' })).toThrow(ReportError);
    expect(readLlmConfig({ LLM_API_KEY: 'k', LLM_BASE_URL: 'https://api.moonshot.cn/v1/', LLM_MODEL: 'm' })).toEqual({
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'm',
    });
  });
});

describe('generateAnalysis', () => {
  const config = { apiKey: 'sk-test', baseUrl: 'https://llm.test/v1', model: 'test-model' };

  it('posts an OpenAI-compatible request and returns only the final content', async () => {
    const fetchFn = mockFetch({
      'https://llm.test/v1/chat/completions': {
        choices: [{ message: { role: 'assistant', reasoning_content: '思考中', content: '  今日解读  ' } }],
      },
    });

    expect(await generateAnalysis('prompt text', config)).toBe('今日解读');

    const [, init] = fetchFn.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('test-model');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'prompt text' });
  });

  it('surfaces upstream error details without leaking the key', async () => {
    mockFetch({
      'https://llm.test/v1/chat/completions': new Response('{"error":"invalid api key"}', { status: 401 }),
    });

    const err = await generateAnalysis('p', config).then(
      () => {
        throw new Error('expected generateAnalysis to reject');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(ReportError);
    expect(err.stage).toBe('llm');
    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('invalid api key');
    expect(err.message).not.toContain('sk-test');
  });

  it('rejects empty content', async () => {
    mockFetch({ 'https://llm.test/v1/chat/completions': { choices: [{ message: { content: '' } }] } });

    await expect(generateAnalysis('p', config)).rejects.toMatchObject({ stage: 'llm' });
  });
});

describe('buildPrompt', () => {
  const repo = { name: 'a/b', description: 'agent tool', stars: 1200, language: 'Rust', languageColor: null, url: 'https://github.com/a/b' };

  it('includes every repo and news item, with star deltas and HN points when known', () => {
    const prompt = buildPrompt(
      [{ ...repo, addStars: 300 }, { ...repo, name: 'c/d', addStars: null }],
      [{ title: 'Claude news', url: 'https://claude.com/x', source: 'claude.com', points: 120 }],
    );
    expect(prompt).toContain('a/b（Rust，1200 stars，新增 300）：agent tool');
    expect(prompt).toContain('c/d（Rust，1200 stars）：agent tool');
    expect(prompt).toContain('Claude news（来源：claude.com，HN 120 分）');
    expect(prompt).toContain('300 字');
  });
});

describe('fillStarDeltas', () => {
  const repo = (name, stars, addStars = null) => ({ name, description: '', stars, addStars, language: null, languageColor: null, url: `https://github.com/${name}` });
  const previous = {
    generatedAt: '2026-11-06T00:40:00.000Z',
    githubTrending: [{ name: 'a/b', stars: 1000 }, { name: 'c/d', stars: 50 }],
  };

  it('diffs against the previous data.json and leaves new repos as null', () => {
    const { repos, since } = fillStarDeltas([repo('a/b', 1250), repo('new/one', 900), repo('c/d', 40)], previous);

    expect(repos.map((r) => r.addStars)).toEqual([250, null, 0]);
    expect(since).toBe('2026-11-06T00:40:00.000Z');
  });

  it('keeps deltas that already came from the feed and reports no baseline', () => {
    const { repos, since } = fillStarDeltas([repo('a/b', 1250, 77)], previous);

    expect(repos[0].addStars).toBe(77);
    expect(since).toBeNull();
  });

  it.each([null, 'garbage', { githubTrending: 'nope' }])('tolerates a missing or malformed previous file: %j', (prev) => {
    expect(fillStarDeltas([repo('a/b', 1)], prev)).toEqual({ repos: [repo('a/b', 1)], since: null });
  });
});

describe('extractKeywords', () => {
  it('ranks by number of matching items and matches whole words only', () => {
    const keywords = extractKeywords(
      [{ name: 'x/agent-kit', description: 'Claude Code agents in Rust' }, { name: 'y/storage', description: 'fast object storage' }],
      [
        { title: 'Claude Code sends your email address to websites' },
        { title: 'Agentic coding with open-weight LLMs' },
        { title: 'Facebook runs AI deepfake scam ads' },
      ],
    );

    expect(keywords).toEqual(['Claude', 'Agent', 'LLM', '开源', '安全', 'Rust']);
    // storage 不应命中 RAG
    expect(keywords).not.toContain('RAG');
  });

  it('returns at most 6 keywords and an empty list when nothing matches', () => {
    expect(extractKeywords([], [{ title: 'Claude Anthropic OpenAI DeepSeek agent LLM MCP RAG' }])).toHaveLength(6);
    expect(extractKeywords([], [{ title: 'Nothing relevant here' }])).toEqual([]);
  });
});

describe('updateData', () => {
  // 一套全部成功的上游接口：isboyjc 过期 → 降级 Search，HN 正常，大模型正常
  const happyRoutes = () => ({
    [TRENDING_URL]: { pubDate: 'Wed, 26 Aug 2026 13:56:53 GMT', items: [] },
    [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', language: 'Rust', stargazers_count: 7 }] },
    [HN_URL]: { hits: [{ title: 'New open LLM released', url: 'https://example.com/llm', points: 10, objectID: '1' }] },
    'https://llm.test/v1/chat/completions': { choices: [{ message: { content: '第一段\n\n第二段' } }] },
  });

  function tempDataPath() {
    const sub = mkdtempSync(join(dir, 'out-'));
    return join(sub, 'public', 'data.json');
  }

  it('writes the full report to data.json', async () => {
    mockFetch(happyRoutes());
    const path = tempDataPath();

    const report = await updateData({ now: NOW, env: LLM_ENV, path });

    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved).toEqual(report);
    expect(saved).toMatchObject({
      date: '2026-11-06',
      githubTrending: [
        { name: 'a/b', description: '', stars: 7, addStars: null, language: 'Rust', languageColor: '#dea584', url: 'https://github.com/a/b' },
      ],
      aiNews: [{ title: 'New open LLM released', url: 'https://example.com/llm', source: 'example.com', points: 10 }],
      aiAnalysis: '第一段\n\n第二段',
      // 只看名称、描述和标题，不看 language 字段
      keywords: ['LLM'],
      githubSource: 'search',
      githubDataDate: '2026-11-06',
      addStarsSince: null,
    });
    expect(Number.isNaN(Date.parse(saved.generatedAt))).toBe(false);
    // 不留临时文件
    expect(readdirSync(dirname(path))).toEqual(['data.json']);
  });

  it('computes star deltas against the previous data.json', async () => {
    const path = tempDataPath();
    mockFetch(happyRoutes());
    const first = await updateData({ now: NOW, env: LLM_ENV, path });

    const routes = happyRoutes();
    routes[SEARCH_URL].items[0].stargazers_count = 19;
    mockFetch(routes);
    const second = await updateData({ now: new Date(NOW.getTime() + 86400_000), env: LLM_ENV, path });

    expect(second.githubTrending[0].addStars).toBe(12);
    expect(second.addStarsSince).toBe(first.generatedAt);
  });

  it.each([
    ['news', { [HN_URL]: new Response('down', { status: 503 }) }],
    ['llm', { 'https://llm.test/v1/chat/completions': new Response('{"error":"invalid api key"}', { status: 401 }) }],
  ])('keeps the previous data.json untouched when the %s stage fails', async (stage, override) => {
    const path = tempDataPath();
    mockFetch(happyRoutes());
    await updateData({ now: NOW, env: LLM_ENV, path });
    const before = readFileSync(path, 'utf8');

    mockFetch({ ...happyRoutes(), ...override });
    await expect(updateData({ now: NOW, env: LLM_ENV, path })).rejects.toMatchObject({ stage });

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dirname(path))).toEqual(['data.json']);
  });

  it('fails on missing LLM config before making any request and writes nothing', async () => {
    const fetchFn = mockFetch(happyRoutes());
    const path = tempDataPath();

    await expect(updateData({ now: NOW, env: {}, path })).rejects.toMatchObject({ stage: 'config' });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it('writes to public/data.json under the project root by default', () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(DATA_PATH).toBe(join(projectRoot, 'public', 'data.json'));
  });
});

describe('loadEnvFile', () => {
  const LINES = ['LLM_API_KEY=sk-test', 'LLM_BASE_URL=https://api.deepseek.com', 'LLM_MODEL=deepseek-chat'];
  const EXPECTED = { LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-chat' };
  let n = 0;

  function load(buf, env = {}) {
    const path = join(dir, `${n++}.env`);
    writeFileSync(path, buf);
    const result = loadEnvFile(path, env);
    return { result, env };
  }

  it.each([
    ['LF', Buffer.from(LINES.join('\n'))],
    ['CRLF', Buffer.from(LINES.join('\r\n') + '\r\n')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINES.join('\r\n'))])],
    ['UTF-16 LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LINES.join('\r\n'), 'utf16le')])],
    ['UTF-16 BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(LINES.join('\r\n'), 'utf16le').swap16()])],
  ])('reads every variable from a %s file', (_name, buf) => {
    const { result, env } = load(buf);

    expect(env).toEqual(EXPECTED);
    expect(result.keys).toEqual(Object.keys(EXPECTED));
  });

  it('keeps non-empty existing variables but fills empty ones', () => {
    const { env } = load(Buffer.from(LINES.join('\n')), { LLM_API_KEY: 'from-shell', LLM_MODEL: '' });

    expect(env.LLM_API_KEY).toBe('from-shell');
    expect(env.LLM_MODEL).toBe('deepseek-chat');
  });

  it('reports a missing file without touching env', () => {
    const env = {};
    expect(loadEnvFile(join(dir, 'nope.env'), env)).toEqual({ path: join(dir, 'nope.env'), found: false, keys: [] });
    expect(env).toEqual({});
  });

  it('resolves the default path to the project root, not the cwd', () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(ENV_PATH).toBe(join(projectRoot, '.env'));
  });
});

describe('decodeEnvFile', () => {
  it('strips a UTF-8 BOM', () => {
    expect(decodeEnvFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A=1')]))).toBe('A=1');
  });
});
