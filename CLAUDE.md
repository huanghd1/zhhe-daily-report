# 项目说明

TypeScript + Fastify + Drizzle 的后端服务，数据库使用 libsql（本地默认 SQLite 文件）。

## 项目结构

```
.
├── src/
│   ├── app.ts          # 构建 Fastify 实例，注册路由（/health、/users），db 由调用方注入
│   ├── app.test.ts     # vitest 测试，使用 app.inject 和内存库，不占用端口
│   ├── load-env.ts     # 读取根目录 .env 到 process.env，由 server.ts 最先导入
│   ├── server.ts       # 入口，加载 .env 后读取 PORT / HOST 并监听
│   └── db/
│       ├── index.ts    # libsql 版 Drizzle 客户端，导出 db
│       └── schema.ts   # 数据表定义，目前有 users 表
├── drizzle/            # 迁移文件（由 db:generate 生成，需提交到版本库）
├── data/               # 本地 SQLite 文件目录（db:migrate 前需存在）
├── .env                # 本地环境变量，不进版本库
├── drizzle.config.ts   # drizzle-kit 配置，迁移输出到 drizzle/
├── tsconfig.json       # 编译范围 src/**/*.ts，排除 *.test.ts
├── package.json
└── .gitignore          # 忽略 node_modules、dist、data、*.db、.env
```

## 启动 / 测试 / 构建命令

```bash
npm install                 # 安装依赖（见下方注意事项）
npm run build               # tsc 编译到 dist/
npm test -- --reporter=dot  # vitest 运行全部测试
npm start                   # 运行 dist/server.js（需先 build）
npm run dev                 # tsx watch 开发模式，直接运行 src/server.ts
npm run db:generate         # drizzle-kit 根据 schema.ts 生成迁移
npm run db:migrate          # 执行迁移
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，可改为 `127.0.0.1` 限制本机访问 |
| `DATABASE_URL` | `file:./data/app.db` | libsql / SQLite 连接地址 |
| `AUTH_TOKEN` | 无（必填） | `/users` 接口的访问令牌，未设置时 `buildApp` 直接报错 |

环境变量可写在根目录 `.env` 中（格式 `KEY=value`），服务启动时由 `src/load-env.ts` 读取。`.env` 已被 `.gitignore` 忽略，不要提交。测试会自行设置 `AUTH_TOKEN`，不依赖 `.env`。

## 鉴权机制

- `/users` 要求请求头 `Authorization: Bearer <AUTH_TOKEN>`，缺失或不匹配返回 401 `{"error":"unauthorized"}`。
- 比较使用 `crypto.timingSafeEqual`，避免通过响应耗时逐字节猜测 token。
- `/health` 无认证，仅用于存活检查，不返回数据。
- 当前是单一共享 token，不区分用户。若要按用户授权，需另行设计。

## 数据库迁移

```bash
npm run db:generate   # 修改 schema.ts 后执行，在 drizzle/ 下生成 SQL 迁移文件
mkdir -p data         # 首次运行前创建本地数据目录
npm run db:migrate    # 将迁移应用到 DATABASE_URL 指定的数据库
```

迁移文件与 `schema.ts` 必须同步提交。测试库不跑迁移，而是在 `app.test.ts` 中手动建表，改动 `users` 表结构时两处都要更新。

## 依赖版本

运行时（精确锁定）：

- fastify 5.12.8
- drizzle-orm 0.45.4
- @libsql/client 0.18.0

开发依赖（精确锁定）：

- typescript 7.0.2
- vitest 5.1.0
- drizzle-kit 0.31.11
- tsx 4.23.15
- @types/node 24.19.2

运行环境：Node 24.22.1，npm 11.19.1（Windows 11）。

## 注意事项

- 安装依赖时 npm 偶尔因堆内存断言崩溃（退出码 134）。重试即可，单独安装失败的包通常能成功。
- esbuild 的 postinstall 脚本已通过 `npm install-scripts approve esbuild` 批准，记录在 package.json 的 `allowScripts` 中。
- 服务默认监听 0.0.0.0，局域网内可访问 `/health` 和带 token 的 `/users`。新增接口前需先确定访问控制方案。
- `drizzle.config.ts` 已在本地跑通 `db:generate` 和 `db:migrate`。
