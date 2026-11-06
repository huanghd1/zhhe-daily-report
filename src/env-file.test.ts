import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeEnvFile, ENV_PATH, loadEnvFile } from './env-file.js';

const LINES = ['AUTH_TOKEN=abc', 'LLM_API_KEY=sk-test', 'LLM_BASE_URL=https://api.deepseek.com', 'LLM_MODEL=deepseek-flash'];
const EXPECTED = {
  AUTH_TOKEN: 'abc',
  LLM_API_KEY: 'sk-test',
  LLM_BASE_URL: 'https://api.deepseek.com',
  LLM_MODEL: 'deepseek-flash',
};

const dir = mkdtempSync(join(tmpdir(), 'env-file-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function load(buf: Buffer, env: NodeJS.ProcessEnv = {}) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(path, buf);
  const result = loadEnvFile(path, env);
  return { result, env };
}

describe('loadEnvFile', () => {
  it.each([
    ['LF', Buffer.from(LINES.join('\n'))],
    ['CRLF', Buffer.from(LINES.join('\r\n') + '\r\n')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINES.join('\r\n'))])],
    ['UTF-16 LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LINES.join('\r\n'), 'utf16le')])],
    ['UTF-16 BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(LINES.join('\r\n'), 'utf16le').swap16()])],
  ])('reads every variable from a %s file', (_name, buf) => {
    const { result, env } = load(buf);

    expect(env).toEqual(EXPECTED);
    expect(result.keys).toEqual(Object.keys(EXPECTED));
  });

  it('keeps non-empty existing variables but fills empty ones', () => {
    const { env } = load(Buffer.from(LINES.join('\n')), { AUTH_TOKEN: 'from-shell', LLM_MODEL: '' });

    expect(env.AUTH_TOKEN).toBe('from-shell');
    expect(env.LLM_MODEL).toBe('deepseek-flash');
  });

  it('reports a missing file without touching env', () => {
    const env = {};
    expect(loadEnvFile(join(dir, 'nope.env'), env)).toEqual({ path: join(dir, 'nope.env'), found: false, keys: [] });
    expect(env).toEqual({});
  });

  it('resolves the default path to the project root, not the cwd', () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(ENV_PATH).toBe(join(projectRoot, '.env'));
  });
});

describe('decodeEnvFile', () => {
  it('strips a UTF-8 BOM', () => {
    expect(decodeEnvFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A=1')]))).toBe('A=1');
  });
});
