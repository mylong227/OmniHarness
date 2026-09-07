import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecCli } from '../../src/cli/execImpl.js';
import { API_VERSION } from '../../src/version.js';

/** 临时劫持 stdout，收集写入内容后恢复（单线程测试环境安全）。 */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  const spy = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stdout.write = spy as typeof process.stdout.write;
  try {
    await fn();
    return chunks.join('');
  } finally {
    process.stdout.write = orig;
  }
}

test('CLI --version 打印 API 契约版本并早退（exit 0）', async () => {
  const cli = new ExecCli();
  const out = await captureStdout(() => cli.run(['--version']));
  assert.strictEqual(out, `omniharness ${API_VERSION}\n`);
});

test('CLI -V 短选项等价于 --version', async () => {
  const cli = new ExecCli();
  const out = await captureStdout(() => cli.run(['-V']));
  assert.strictEqual(out, `omniharness ${API_VERSION}\n`);
});

test('--version 在任何子命令前均早退（不触发配置/Agent 装配）', async () => {
  const cli = new ExecCli();
  const out = await captureStdout(() => cli.run(['eval', '--version']));
  assert.strictEqual(out, `omniharness ${API_VERSION}\n`);
});
