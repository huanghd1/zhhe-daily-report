import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from './db/schema.js';
import { users } from './db/schema.js';

export interface AppOptions {
  // 数据库实例由调用方注入：服务入口传入全局 db，测试传入内存库
  db: LibSQLDatabase<typeof schema>;
}

// 邮箱格式做基础校验，唯一性由数据库 UNIQUE 约束保证
const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
};

const createBody = {
  type: 'object',
  required: ['name', 'email'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', minLength: 3, maxLength: 254, pattern: EMAIL_PATTERN },
  },
};

// 更新接口所有字段可选，但至少要提供一个字段
const updateBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', minLength: 3, maxLength: 254, pattern: EMAIL_PATTERN },
  },
};

// 判断错误链中是否包含 SQLite 的唯一约束冲突（drizzle 会把原始错误包在 cause 里）
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current.message.includes('UNIQUE constraint failed')) return true;
    current = current.cause;
  }
  return false;
}

// 构建 Fastify 应用实例，不直接监听端口，便于测试复用
export function buildApp({ db }: AppOptions): FastifyInstance {
  // token 从环境变量读取；未配置时直接报错，避免以空 token 对外提供服务
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    throw new Error('AUTH_TOKEN is not set');
  }
  const expected = Buffer.from(`Bearer ${authToken}`);

  const app = Fastify({ logger: false });

  // 鉴权钩子挂在 onRequest 阶段：在解析请求体和参数校验之前执行，未授权请求不会看到校验错误
  async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    // 使用常量时间比较，避免通过响应耗时逐字节猜出 token
    const provided = Buffer.from(request.headers.authorization ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/users', { onRequest: requireAuth }, async () => {
    return db.select().from(users).orderBy(users.id).all();
  });

  app.post('/users', { onRequest: requireAuth, schema: { body: createBody } }, async (request, reply) => {
    const body = request.body as { name: string; email: string };
    try {
      const [user] = await db.insert(users).values(body).returning();
      return reply.code(201).send(user);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'email already exists' });
      }
      throw err;
    }
  });

  app.put<{ Params: { id: number } }>(
    '/users/:id',
    { onRequest: requireAuth, schema: { params: idParams, body: updateBody } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as { name?: string; email?: string };
      try {
        const [user] = await db.update(users).set(body).where(eq(users.id, id)).returning();
        if (!user) {
          return reply.code(404).send({ error: 'not found' });
        }
        return user;
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'email already exists' });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/users/:id',
    { onRequest: requireAuth, schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params;
      const [deleted] = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
      if (!deleted) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.code(204).send();
    },
  );

  return app;
}
