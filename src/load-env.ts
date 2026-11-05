import { existsSync } from 'node:fs';

// 在入口最先导入，把根目录 .env 载入 process.env；文件不存在时跳过（如 CI 环境直接使用真实环境变量）
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
