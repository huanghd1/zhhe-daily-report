import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import * as schema from './db/schema.js';
import { localDate, TRENDING_URL } from './services/dailyService.js';

// 测试使用固定 token，不依赖本地 .env（该文件不进版本库）
const TEST_TOKEN = 'test-token';
process.env.AUTH_TOKEN = TEST_TOKEN;

// 使用内存数据库，不读写本地 SQLite 文件
const client = createClient({ url: ':memory:' });
const db = drizzle({ client, schema });

const app = buildApp({ db });
const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

beforeAll(async () => {
  // 测试库没有迁移，这里手动建表，列定义与 schema.ts 保持一致
  await client.execute(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // 与 drizzle/0001 迁移保持一致
  await client.execute(`
    CREATE TABLE daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      github_trending TEXT NOT NULL,
      ai_news TEXT NOT NULL,
      ai_analysis TEXT NOT NULL,
      github_source TEXT NOT NULL,
      github_data_date TEXT NOT NULL,
      generated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
});

beforeEach(async () => {
  // 每个用例前清空数据并重置自增计数，保证 id 可预测
  await client.execute('DELETE FROM users');
  await client.execute('DELETE FROM daily_reports');
  await client.execute("DELETE FROM sqlite_sequence WHERE name IN ('users', 'daily_reports')");
});

afterAll(async () => {
  await app.close();
  client.close();
});

// 直接写库准备测试数据，返回新行的 id
async function insertUser(name: string, email: string): Promise<number> {
  const res = await client.execute({
    sql: 'INSERT INTO users (name, email) VALUES (?, ?)',
    args: [name, email],
  });
  return Number(res.lastInsertRowid);
}

describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/fortune', () => {
  it('returns a fortune string without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fortune' });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().fortune).toBe('string');
    expect(res.json().fortune.length).toBeGreaterThan(0);
  });
});

describe('GET /fortune', () => {
  it('serves the fortune page as html', async () => {
    const res = await app.inject({ method: 'GET', url: '/fortune' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('赛博求签');
  });
});

describe('GET /users', () => {
  it('returns 401 when the authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/users' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when the token is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns an empty array when there are no users', async () => {
    const res = await app.inject({ method: 'GET', url: '/users', headers: authHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns all users ordered by id', async () => {
    await insertUser('alice', 'alice@example.com');
    await insertUser('bob', 'bob@example.com');

    const res = await app.inject({ method: 'GET', url: '/users', headers: authHeaders });
    const body = res.json<Array<{ id: number; name: string; email: string; createdAt: string }>>();

    expect(res.statusCode).toBe(200);
    expect(body.map((u) => [u.id, u.name, u.email])).toEqual([
      [1, 'alice', 'alice@example.com'],
      [2, 'bob', 'bob@example.com'],
    ]);
    expect(body[0].createdAt).toBeDefined();
  });
});

describe('POST /users', () => {
  it('returns 401 without a valid token, even with an invalid body', async () => {
    const res = await app.inject({ method: 'POST', url: '/users', payload: {} });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 400 when name or email is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: authHeaders,
      payload: { name: 'carol' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email is malformed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: authHeaders,
      payload: { name: 'carol', email: 'not-an-email' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('creates a user and returns 201 with the new row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: authHeaders,
      payload: { name: 'carol', email: 'carol@example.com' },
    });
    const body = res.json<{ id: number; name: string; email: string; createdAt: string }>();

    expect(res.statusCode).toBe(201);
    expect(body).toMatchObject({ id: 1, name: 'carol', email: 'carol@example.com' });
    expect(body.createdAt).toBeDefined();
  });

  it('returns 409 when the email is already taken', async () => {
    await insertUser('alice', 'alice@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: authHeaders,
      payload: { name: 'alice2', email: 'alice@example.com' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'email already exists' });
  });
});

describe('PUT /users/:id', () => {
  it('returns 401 without a valid token', async () => {
    const id = await insertUser('alice', 'alice@example.com');

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${id}`,
      headers: { authorization: 'Bearer wrong-token' },
      payload: { name: 'alice2' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when the body is empty', async () => {
    const id = await insertUser('alice', 'alice@example.com');

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${id}`,
      headers: authHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the user does not exist', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/users/999',
      headers: authHeaders,
      payload: { name: 'ghost' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('updates only the provided fields', async () => {
    const id = await insertUser('alice', 'alice@example.com');

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${id}`,
      headers: authHeaders,
      payload: { name: 'alice2' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, name: 'alice2', email: 'alice@example.com' });
  });

  it('returns 409 when the new email belongs to another user', async () => {
    await insertUser('alice', 'alice@example.com');
    const bobId = await insertUser('bob', 'bob@example.com');

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${bobId}`,
      headers: authHeaders,
      payload: { email: 'alice@example.com' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'email already exists' });
  });
});

describe('DELETE /users/:id', () => {
  it('returns 401 without a valid token', async () => {
    const id = await insertUser('alice', 'alice@example.com');

    const res = await app.inject({ method: 'DELETE', url: `/users/${id}` });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 404 when the user does not exist', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/users/999', headers: authHeaders });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('deletes the user and returns 204', async () => {
    const id = await insertUser('alice', 'alice@example.com');

    const res = await app.inject({ method: 'DELETE', url: `/users/${id}`, headers: authHeaders });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/users', headers: authHeaders });
    expect(list.json()).toEqual([]);
  });
});

describe('static files', () => {
  it('serves the daily report page at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('每日前沿科技与 GitHub 趋势简报');
  });

  it.each(['/data/app.db', '/package.json', '/src/app.ts', '/node_modules/fastify/package.json', '/.env', '/public/index.html'])(
    'does not expose project file %s',
    async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
    },
  );
});

// ---------- 每日简报 ----------

// 一次完整生成所需的上游响应：isboyjc 新鲜榜单、HN 搜索、OpenAI 兼容的大模型接口
const LLM_BASE = 'https://llm.test/v1';
function stubUpstreams(options: { analysis?: string; llmStatus?: number; onLlm?: () => Promise<void> | void } = {}) {
  const fetchFn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === TRENDING_URL) {
      return Response.json({
        pubDate: new Date().toUTCString(),
        items: [1, 2, 3, 4, 5, 6].map((i) => ({
          title: `owner/repo-${i}`,
          url: `https://github.com/owner/repo-${i}`,
          description: `desc ${i}`,
          language: i % 2 ? 'TypeScript' : 'Rust',
          stars: `${i},234`,
        })),
      });
    }
    if (url.startsWith('https://hn.algolia.com/api/v1/search')) {
      return Response.json({
        hits: [
          { title: 'Claude ships something', url: 'https://www.anthropic.com/news/x', points: 300, objectID: '1' },
          { title: 'New open LLM', url: 'https://example.com/llm', points: 120, objectID: '2' },
          { title: 'AI agents in prod', url: 'https://blog.dev/agents', points: 80, objectID: '3' },
        ],
      });
    }
    if (url === `${LLM_BASE}/chat/completions`) {
      await options.onLlm?.();
      if (options.llmStatus) return new Response('{"error":"bad key"}', { status: options.llmStatus });
      return Response.json({ choices: [{ message: { content: options.analysis ?? '今日解读：智能体工具持续升温。' } }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

function stubLlmEnv() {
  vi.stubEnv('LLM_API_KEY', 'sk-test');
  vi.stubEnv('LLM_BASE_URL', LLM_BASE);
  vi.stubEnv('LLM_MODEL', 'test-model');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function generate(headers: Record<string, string> = authHeaders) {
  return app.inject({ method: 'POST', url: '/api/reports/generate', headers });
}

describe('GET /api/reports/today', () => {
  it('returns 404 with today\'s date before the report is generated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reports/today' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'report not generated yet', date: localDate() });
  });
});

describe('POST /api/reports/generate', () => {
  it('returns 401 without a valid token and makes no upstream calls', async () => {
    stubLlmEnv();
    const fetchFn = stubUpstreams();

    const missing = await generate({});
    const wrong = await generate({ authorization: 'Bearer wrong-token' });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns 503 when the LLM is not configured, before calling any upstream', async () => {
    vi.stubEnv('LLM_API_KEY', '');
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    const fetchFn = stubUpstreams();

    const res = await generate();

    expect(res.statusCode).toBe(503);
    expect(res.json().stage).toBe('config');
    expect(res.json().error).toContain('LLM_API_KEY');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns 502 and writes nothing when the LLM call fails', async () => {
    stubLlmEnv();
    stubUpstreams({ llmStatus: 401 });

    const res = await generate();

    expect(res.statusCode).toBe(502);
    expect(res.json().stage).toBe('llm');
    const today = await app.inject({ method: 'GET', url: '/api/reports/today' });
    expect(today.statusCode).toBe(404);
  });

  it('runs the full chain: fetch → analyse → store → serve via /today', async () => {
    stubLlmEnv();
    stubUpstreams();

    const res = await generate();
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.date).toBe(localDate());
    expect(report.githubSource).toBe('trending');
    expect(report.githubTrending).toHaveLength(5);
    expect(report.githubTrending[0]).toEqual({
      name: 'owner/repo-1',
      description: 'desc 1',
      stars: 1234,
      language: 'TypeScript',
      url: 'https://github.com/owner/repo-1',
    });
    expect(report.aiNews.map((n: { source: string }) => n.source)).toEqual(['anthropic.com', 'example.com', 'blog.dev']);
    expect(report.aiAnalysis).toBe('今日解读：智能体工具持续升温。');

    const today = await app.inject({ method: 'GET', url: '/api/reports/today' });
    expect(today.statusCode).toBe(200);
    expect(today.json()).toEqual(report);

    // 库里存的是 JSON 字符串
    const raw = await client.execute('SELECT github_trending, ai_news FROM daily_reports');
    expect(typeof raw.rows[0].github_trending).toBe('string');
    expect(JSON.parse(String(raw.rows[0].ai_news))).toEqual(report.aiNews);
  });

  it('overwrites today\'s report when generated again', async () => {
    stubLlmEnv();
    stubUpstreams({ analysis: '第一版' });
    const first = (await generate()).json();

    stubUpstreams({ analysis: '第二版' });
    const second = (await generate()).json();

    expect(second.id).toBe(first.id);
    expect(second.aiAnalysis).toBe('第二版');
    const count = await client.execute('SELECT COUNT(*) AS n FROM daily_reports');
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('shares one generation between concurrent requests', async () => {
    stubLlmEnv();
    const onLlm = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    stubUpstreams({ onLlm });

    const [a, b] = await Promise.all([generate(), generate()]);

    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(onLlm).toHaveBeenCalledTimes(1);
  });
});
