import { loadEnvFile } from './env-file.js';

// 在入口最先导入，把项目根目录的 .env 载入 process.env；文件不存在时跳过（如 CI 环境直接使用真实环境变量）
const result = loadEnvFile();

// 启动时打印读到了哪些变量名（不打印值），.env 没保存或放错位置时一眼就能看出来
if (result.found) {
  console.log(`已读取 ${result.path}：${result.keys.length ? result.keys.join(', ') : '（没有任何变量）'}`);
} else {
  console.log(`未找到 ${result.path}，仅使用系统环境变量`);
}
