# zhhe-reonr

基于 TypeScript、Fastify 和 Drizzle ORM 的后端服务示例，数据库使用 libsql（默认本地 SQLite 文件）。

提供以下接口：

- `GET /health`：存活检查，无需认证
- `GET /users`：查询用户列表
- `POST /users`：创建用户，接收 `name`、`email`
- `PUT /users/:id`：更新用户的 `name` 或 `email`
- `DELETE /users/:id`：删除用户

除 `/health` 外，所有接口都需要请求头 `Authorization: Bearer <AUTH_TOKEN>`。

## 前置要求

- Node.js 24 或以上
- npm 11 或以上

## 安装

```bash
git clone <仓库地址>
cd zhhe-reonr
npm install
```

## 环境配置

复制示例文件并填入自己的 token：

```bash
cp .env.example .env
```

`.env` 中的变量如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUTH_TOKEN` | 无（必填） | `/users` 接口的访问令牌，未设置时服务无法启动 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，设为 `127.0.0.1` 可限制只允许本机访问 |
| `DATABASE_URL` | `file:./data/app.db` | libsql / SQLite 连接地址 |

`.env` 已被 `.gitignore` 忽略，不要提交到版本库。

## 数据库

首次运行前创建数据目录并执行迁移：

```bash
mkdir -p data
npm run db:migrate
```

修改 `src/db/schema.ts` 后，执行 `npm run db:generate` 生成新的迁移文件，并与代码一起提交。

## 运行测试

```bash
npm test
```

测试使用内存数据库，不会读写本地文件，也不依赖 `.env`。

## 启动服务

开发模式（文件变动自动重启）：

```bash
npm run dev
```

生产模式（需先编译）：

```bash
npm run build
npm start
```

## 许可证

[MIT](LICENSE)
