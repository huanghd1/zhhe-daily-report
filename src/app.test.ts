import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import * as schema from './db/schema.js';

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
});

beforeEach(async () => {
  // 每个用例前清空数据并重置自增计数，保证 id 可预测
  await client.execute('DELETE FROM users');
  await client.execute("DELETE FROM sqlite_sequence WHERE name = 'users'");
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
