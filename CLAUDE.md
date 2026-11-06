# 项目说明

TypeScript + Fastify + Drizzle 的后端服务，数据库使用 libsql（本地默认 SQLite 文件）。

## 项目结构

```
.
├── src/
│   ├── app.ts          # 构建 Fastify 实例，注册全部路由，db 由调用方注入
│   ├── app.test.ts     # 路由测试，使用 app.inject、内存库和 mock fetch，不占用端口、不发外网请求
│   ├── load-env.ts     # 读取根目录 .env 到 process.env 并打印读到的变量名，由 server.ts 最先导入
│   ├── env-file.ts     # .env 解析：按项目根目录定位，兼容 UTF-8 BOM / UTF-16（不依赖 dotenv）
│   ├── server.ts       # 入口，加载 .env 后监听端口，并启动每天 08:00 的简报定时任务
│   ├── scheduler.ts    # 原生 setTimeout 实现的每日定时任务（不依赖 node-cron）
│   ├── services/
│   │   └── dailyService.ts  # 每日简报：抓 GitHub 榜单、HN AI 快讯，调用大模型分析，按日期入库
│   └── db/
│       ├── index.ts    # libsql 版 Drizzle 客户端，导出 db
│       └── schema.ts   # 数据表定义：users、daily_reports
├── public/index.html   # 每日简报页面（GET /），纯 HTML/CSS/JS
├── fortune.html        # 赛博求签页面（GET /fortune）
├── drizzle/            # 迁移文件（由 db:generate 生成，需提交到版本库）
├── data/               # 本地 SQLite 文件目录（db:migrate 前需存在）
├── .env                # 本地环境变量，不进版本库
├── .env.example        # 环境变量模板（可提交）
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
| `AUTH_TOKEN` | 无（必填） | `/users` 和 `POST /api/reports/generate` 的访问令牌，未设置时 `buildApp` 直接报错 |
| `LLM_API_KEY` | 无 | 大模型 API key（OpenAI 兼容协议） |
| `LLM_BASE_URL` | 无 | 如 `https://api.deepseek.com` 或 `https://api.moonshot.cn/v1`，请求 `${LLM_BASE_URL}/chat/completions` |
| `LLM_MODEL` | 无 | 如 `deepseek-flash`、`kimi-k3.1-pro` |

环境变量可写在根目录 `.env` 中（格式 `KEY=value`，模板见 `.env.example`），服务启动时由 `src/load-env.ts` 读取，已存在且非空的系统环境变量优先。`.env` 已被 `.gitignore` 忽略，不要提交。测试会自行设置 `AUTH_TOKEN` 和 LLM 变量，不依赖 `.env`。

三个 `LLM_*` 变量缺失时服务照常启动（会打印提示），只有生成简报会返回 503。

## 鉴权机制

- `/users` 和 `POST /api/reports/generate` 要求请求头 `Authorization: Bearer <AUTH_TOKEN>`，缺失或不匹配返回 401 `{"error":"unauthorized"}`。generate 会请求外部接口并消耗大模型额度，所以必须鉴权。
- 比较使用 `crypto.timingSafeEqual`，避免通过响应耗时逐字节猜测 token。
- 公开接口：`/health`（存活检查）、`/`（简报页面）、`/fortune`、`/api/fortune`、`GET /api/reports/today`（只读，数据均来自公开来源）。
- 当前是单一共享 token，不区分用户。若要按用户授权，需另行设计。
- 静态文件：`@fastify/static` 以 `serve: false` 注册，只提供 `reply.sendFile`，每个页面单独写路由。不要改成 `wildcard: false`，那样会为根目录下每个文件注册路由，`data/app.db`、`src/`、`node_modules/` 都能被下载。`app.test.ts` 里有对应的防回归用例。

## 每日简报

- 数据源：GitHub 榜单优先用 isboyjc/github-trending-api，它的 `pubDate` 超过 48 小时（2026-08 起已停更）或请求失败时，降级到 GitHub Search API（近 7 天新建、按 star 排序），`github_source` 字段记录实际来源。AI 快讯用 HN Algolia 接口（标题含 AI / LLM / Claude / Anthropic、过去 24 小时、按点赞数取前 5，标题含 stock / IPO / Nasdaq / market / investor 等财经词的会被 `isFinanceTitle` 过滤）。Anthropic 官网没有 RSS，hnrss.org 不稳定，所以没有使用 rss-parser。
- 任一步失败返回 502（`stage` 字段标明 github / news / llm），不写入半成品。同一天重复生成会覆盖当天记录，并发触发会共用同一次执行。
- 日期使用服务器本地时区，定时任务也按本地时间 08:00 执行。

## 数据库迁移

```bash
npm run db:generate   # 修改 schema.ts 后执行，在 drizzle/ 下生成 SQL 迁移文件
mkdir -p data         # 首次运行前创建本地数据目录
npm run db:migrate    # 将迁移应用到 DATABASE_URL 指定的数据库
```

迁移文件与 `schema.ts` 必须同步提交。测试库不跑迁移，而是在 `app.test.ts` 中手动建表，改动 `users` 或 `daily_reports` 表结构时两处都要更新。

## 依赖版本

运行时（精确锁定）：

- fastify 5.12.8
- @fastify/static 10.1.10
- drizzle-orm 0.45.4
- @libsql/client 0.18.0

每日简报的抓取、定时和大模型调用都用 Node 原生能力（`fetch`、`setTimeout`），没有引入 rss-parser、node-cron 或模型 SDK。

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
- 服务默认监听 0.0.0.0，局域网内可访问上面列出的公开接口，以及带 token 的接口。新增接口前需先确定访问控制方案。
- `drizzle.config.ts` 已在本地跑通 `db:generate` 和 `db:migrate`。
