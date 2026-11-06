# zhhe-reonr · 每日前沿科技与 GitHub 趋势简报

纯静态站点，部署在 GitHub Pages。GitHub Actions 每天北京时间 08:00 运行 `scripts/update-data.js`：抓取 GitHub 热门项目和 Hacker News 上的 AI 快讯，调用大模型生成中文解读，写入 `public/data.json` 并提交回仓库，然后把 `public/` 发布到 Pages。页面只读取这个 JSON，没有后端和数据库。

- `/`：每日简报
- `/fortune`：赛博求签（签文写在页面里，纯前端随机抽取）

## 目录结构

```
.
├── public/                 # 发布到 Pages 的全部内容
│   ├── index.html          # 每日简报页面，fetch('./data.json')
│   ├── fortune.html        # 赛博求签
│   └── data.json           # 由脚本生成，Actions 每天自动提交
├── scripts/
│   ├── update-data.js      # 抓取 + 大模型分析 → public/data.json（无第三方依赖）
│   ├── update-data.test.js # vitest 测试，mock fetch，不发外网请求
│   └── preview.js          # 本地预览服务，只监听 127.0.0.1
└── .github/workflows/update.yml
```

## 部署到 GitHub Pages

1. 仓库需为公开仓库（免费账号的私有仓库不能使用 Pages）。
2. Settings → Secrets and variables → Actions → Secrets → New repository secret：名称 `LLM_API_KEY`，值为大模型 API key。
3. 同一页面切到 Variables（可选）：`LLM_BASE_URL`、`LLM_MODEL`。不设置时默认 `https://api.deepseek.com/v1` 和 `deepseek-chat`。
4. Settings → Pages → Build and deployment → Source 选 GitHub Actions。
5. Actions → 每日简报 → Run workflow，手动跑一次。成功后访问 `https://<用户名>.github.io/<仓库名>/`。

之后每天北京时间 08:00 自动更新（GitHub 定时任务高峰期可能延迟十几分钟到半小时）。某天生成失败时，页面继续显示上一份简报并提示未更新，Actions 会发邮件通知。只修改 `public/` 或 `scripts/` 并推送时，workflow 只重新发布，不调用大模型。

## 本地运行

需要 Node.js 24 或以上。

```bash
npm install            # 只装测试用的 vitest；生成脚本本身没有依赖
cp .env.example .env   # 填入 LLM_API_KEY 等
npm run update         # 生成 public/data.json（会调用一次大模型）
npm run preview        # http://127.0.0.1:4173/ 预览页面
npm test               # 运行测试
```

直接双击打开 `public/index.html` 时浏览器会拦截读取 `data.json`，需要通过 `npm run preview` 访问。

## 数据来源

- GitHub：优先使用 isboyjc/github-trending-api 的每日榜单；它超过 48 小时未更新（2026-08 起已停更）或请求失败时，改用 GitHub Search API 的“近 7 天新建、按 star 排序”，页面会标明实际口径。
- AI 快讯：Hacker News Algolia 接口，过去 24 小时标题含 AI / LLM / Claude / Anthropic 的帖子，按点赞数取前 5，过滤股市、IPO 等财经标题。
- 分析：OpenAI 兼容协议的大模型（DeepSeek、Kimi 等）。

## 许可证

[MIT](LICENSE)
