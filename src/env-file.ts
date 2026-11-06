import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// 按项目根目录定位 .env（src 与 dist 的上一级），不依赖启动命令所在的目录
export const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

// 兼容 Windows 上常见的保存格式：UTF-8 带 BOM、UTF-16 LE/BE（记事本“Unicode”）。
// process.loadEnvFile 遇到 BOM 会丢掉第一行，遇到 UTF-16 会整个文件读不出来
export function decodeEnvFile(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface EnvFileResult {
  path: string;
  found: boolean;
  keys: string[]; // 文件中出现的变量名（不含值）
}

// 读取 .env 写入 process.env；已有非空的系统环境变量优先，不被文件覆盖
export function loadEnvFile(path: string = ENV_PATH, env: NodeJS.ProcessEnv = process.env): EnvFileResult {
  if (!existsSync(path)) {
    return { path, found: false, keys: [] };
  }
  const parsed = parseEnv(decodeEnvFile(readFileSync(path)));
  for (const [key, value] of Object.entries(parsed)) {
    if (!env[key]) env[key] = value;
  }
  return { path, found: true, keys: Object.keys(parsed) };
}
