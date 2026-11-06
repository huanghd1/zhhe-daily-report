import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  fetchAiNews,
  fetchGithubTrending,
  generateAnalysis,
  parseStars,
  readLlmConfig,
  ReportError,
  safeUrl,
  TRENDING_URL,
} from './dailyService.js';

const NOW = new Date('2026-11-06T00:30:00Z');

// 按 URL 前缀路由的 fetch 替身；值为函数时可根据请求动态返回，返回 Response 时原样使用
type Handler = unknown | ((url: string, init?: RequestInit) => unknown);
function mockFetch(routes: Record<string, Handler>) {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
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

function trendingItem(i: number, extra: Record<string, unknown> = {}) {
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

describe('fetchGithubTrending', () => {
  it('uses the isboyjc feed when it is fresh, taking the top 5 with numeric stars', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [1, 2, 3, 4, 5, 6].map((i) => trendingItem(i)),
      },
    });

    const result = await fetchGithubTrending(NOW);

    expect(result.source).toBe('trending');
    expect(result.repos).toHaveLength(5);
    expect(result.repos[0]).toEqual({
      name: 'owner/repo-1',
      description: 'desc 1',
      stars: 1000,
      language: 'TypeScript',
      url: 'https://github.com/owner/repo-1',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the GitHub Search API when the feed is older than 48h', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: { pubDate: 'Wed, 26 Aug 2026 13:56:53 GMT', items: [trendingItem(1)] },
      'https://api.github.com/search/repositories': {
        items: [
          { full_name: 'a/b', html_url: 'https://github.com/a/b', description: null, language: null, stargazers_count: 19525 },
        ],
      },
    });

    const result = await fetchGithubTrending(NOW);

    expect(result.source).toBe('search');
    expect(result.repos).toEqual([
      { name: 'a/b', description: '', stars: 19525, language: null, url: 'https://github.com/a/b' },
    ]);
    const searchUrl = new URL(String(fetchFn.mock.calls[1][0]));
    expect(searchUrl.searchParams.get('q')).toBe('created:>=2026-10-30');
    expect(searchUrl.searchParams.get('sort')).toBe('stars');
  });

  it('falls back when the feed request fails', async () => {
    mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      'https://api.github.com/search/repositories': {
        items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 1 }],
      },
    });

    expect((await fetchGithubTrending(NOW)).source).toBe('search');
  });

  it('throws a github-stage error when both sources fail', async () => {
    mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      'https://api.github.com/search/repositories': new Response('rate limited', { status: 403 }),
    });

    await expect(fetchGithubTrending(NOW)).rejects.toMatchObject({ name: 'ReportError', stage: 'github' });
  });

  it('drops items with unsafe urls', async () => {
    mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [trendingItem(1, { url: 'javascript:alert(1)' }), trendingItem(2)],
      },
    });

    const result = await fetchGithubTrending(NOW);
    expect(result.repos.map((r) => r.name)).toEqual(['owner/repo-2']);
  });
});

describe('fetchAiNews', () => {
  it('sorts by points, dedupes titles, links self posts to HN and limits to 5', async () => {
    const fetchFn = mockFetch({
      'https://hn.algolia.com/api/v1/search': {
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
      { title: 'Top story', url: 'https://www.wsj.com/a', source: 'wsj.com' },
      { title: 'Ask HN: agents?', url: 'https://news.ycombinator.com/item?id=4', source: 'news.ycombinator.com' },
      { title: 'Four', url: 'https://four.dev/', source: 'four.dev' },
      { title: 'Five', url: 'https://five.dev/', source: 'five.dev' },
      { title: 'Six', url: 'https://six.dev/', source: 'six.dev' },
    ]);
    // 只查过去 24 小时，关键词之间为 OR
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.searchParams.get('numericFilters')).toBe(`created_at_i>${Math.floor(NOW.getTime() / 1000) - 86400}`);
    expect(url.searchParams.get('optionalWords')).toBe(url.searchParams.get('query'));
  });

  it('throws a news-stage error when nothing matches', async () => {
    mockFetch({ 'https://hn.algolia.com/api/v1/search': { hits: [] } });

    await expect(fetchAiNews(NOW)).rejects.toMatchObject({ stage: 'news' });
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
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init?.body));
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
      (e: unknown) => e as ReportError,
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
  it('includes every repo and news item', () => {
    const prompt = buildPrompt(
      [{ name: 'a/b', description: 'agent tool', stars: 1200, language: 'Rust', url: 'https://github.com/a/b' }],
      [{ title: 'Claude news', url: 'https://claude.com/x', source: 'claude.com' }],
    );
    expect(prompt).toContain('a/b（Rust，1200 stars）：agent tool');
    expect(prompt).toContain('Claude news（来源：claude.com）');
    expect(prompt).toContain('300 字');
  });
});
