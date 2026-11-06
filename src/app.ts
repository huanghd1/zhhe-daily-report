import { randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from './db/schema.js';
import { users } from './db/schema.js';
import { generateDailyReport, getReportByDate, localDate, ReportError } from './services/dailyService.js';

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

// 赛博算命机的签文，/api/fortune 每次随机返回其中一条
const FORTUNES: readonly string[] = [
  '今日宜重构，忌合并 master。',
  'Bug 会在凌晨 3 点找上你，请提前备好咖啡。',
  '宜提交 commit，忌把 commit message 写成 "fix"。',
  '你今天的 console.log 会比你更早被人看见。',
  '宜备份数据库，忌在生产环境里 rm -rf。',
  '此刻写下的 TODO，三年后依然是 TODO。',
  '宜与产品经理和平对话，忌说"这个很简单"。',
  '今日利于 code review，但周五下午请克制 push。',
  '你注定会在某个深夜与 off-by-one 错误相遇。',
  '宜写单元测试，忌相信"在我电脑上是好的"。',
  '宜删除注释掉的旧代码，别怕，Git 记得它们。',
  '中二之气觉醒：你的变量名 x1 将被后人传颂，但不是以好的方式。',
  '今日键盘上的 Ctrl+Z 将拯救你一次。',
  '宜先去睡觉，明天的你修这个 bug 只需十分钟。',
  '忌随手引入一个只有三行的 npm 包。',
  '你将在 Stack Overflow 上找到答案，但它来自 2012 年。',
  '宜与 Git 和解，忌对 main 分支 force push。',
  '星象显示：今天的 sprint 里会有一个"很快就好"的任务。',
  '宜拥抱 AI，但请亲自读一遍它写的代码。',
  '吾之代码，今日必将 "works on my machine" 到底。',
];

// 构建 Fastify 应用实例，不直接监听端口，便于测试复用
export function buildApp({ db }: AppOptions): FastifyInstance {
  // token 从环境变量读取；未配置时直接报错，避免以空 token 对外提供服务
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    throw new Error('AUTH_TOKEN is not set');
  }
  const expected = Buffer.from(`Bearer ${authToken}`);

  const app = Fastify({ logger: false });

  // 项目根目录（src 与 dist 的上一级都是根目录）。serve: false 只注册 reply.sendFile，不自动生成文件路由：
  // 注意 wildcard: false 并不安全，它会为根目录下每个文件注册路由，导致 data/app.db、src、node_modules 可被下载
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  app.register(fastifyStatic, { root: projectRoot, serve: false });

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

  // 静态页面：访问 /fortune 直接返回根目录的 fortune.html，与 /api/fortune 同源，无需 CORS
  app.get('/fortune', async (_request, reply) => {
    return reply.sendFile('fortune.html');
  });

  // 公开接口，无需鉴权
  app.get('/api/fortune', async () => {
    return { fortune: FORTUNES[randomInt(FORTUNES.length)] };
  });

  // 每日简报页面：只返回 public/index.html 这一个文件
  app.get('/', async (_request, reply) => {
    return reply.sendFile('index.html', publicDir);
  });

  // 今日简报，公开只读；当天尚未生成时返回 404 和日期，页面据此显示空状态
  app.get('/api/reports/today', async (_request, reply) => {
    const date = localDate();
    const report = await getReportByDate(db, date);
    if (!report) {
      return reply.code(404).send({ error: 'report not generated yet', date });
    }
    return report;
  });

  // 手动生成：会请求外部接口并消耗大模型额度，必须鉴权
  app.post('/api/reports/generate', { onRequest: requireAuth }, async (_request, reply) => {
    try {
      return await generateDailyReport(db);
    } catch (err) {
      if (err instanceof ReportError) {
        // 未配置 LLM 属于服务端配置问题（503），上游接口失败属于网关错误（502）
        return reply.code(err.stage === 'config' ? 503 : 502).send({ error: err.message, stage: err.stage });
      }
      throw err;
    }
  });

  return app;
}
