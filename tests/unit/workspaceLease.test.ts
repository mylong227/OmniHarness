/**
 * 工作区租约判据：互斥、过期接管、真跨进程串行（构建/测试共享 lease）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceLease } from '../../scripts/workspaceLease.mjs';

/** 在临时根内执行。 */
function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-lease-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('① 互斥：同一工作区第二个持有者必须等待，release 后可获取', async () => {
  await withTemp(async (dir) => {
    const a = new WorkspaceLease(dir, { name: 'workspace', ttlMs: 60_000, pollMs: 10 });
    const b = new WorkspaceLease(dir, { name: 'workspace', ttlMs: 60_000, pollMs: 10 });
    await a.acquire({ timeoutMs: 1_000, label: 'A' });
    await assert.rejects(() => b.acquire({ timeoutMs: 100, label: 'B' }), /超时/);
    a.release();
    await b.acquire({ timeoutMs: 1_000, label: 'B' });
    b.release();
  });
});

test('② 过期接管：TTL 外的陈旧 owner 可被新持有者接管，token 单调增', async () => {
  await withTemp(async (dir) => {
    const lockDir = join(dir, '.omniharness', 'leases', 'workspace');
    mkdirSync(lockDir, { recursive: true });
    const old = Date.now() - 60_000;
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ token: 7, pid: 999_999, host: 'old', at: old, label: 'dead' }),
      'utf8',
    );
    const lease = new WorkspaceLease(dir, { name: 'workspace', ttlMs: 1_000, pollMs: 10 });
    await lease.acquire({ timeoutMs: 1_000, label: 'new' });
    assert.ok(lease.token > 7, `token 必须大于旧 token（实测 ${String(lease.token)}）`);
    assert.strictEqual(lease.holder()?.label, 'new');
    lease.release();
  });
});

test('③ 真跨进程：两个 Node 进程持租约的区间不得重叠', async () => {
  const url = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'workspaceLease.mjs'),
  ).href;
  const dir = mkdtempSync(join(tmpdir(), 'omni-lease-xproc-'));
  try {
    const log = join(dir, 'events.log');
    const script = `
import { WorkspaceLease } from ${JSON.stringify(url)};
import { appendFileSync } from 'node:fs';
const lease = new WorkspaceLease(${JSON.stringify(dir)}, { name: 'workspace', ttlMs: 60000, pollMs: 10 });
await lease.acquire({ timeoutMs: 10000, label: 'child' });
appendFileSync(${JSON.stringify(log)}, 'start ' + Date.now() + '\\n');
await new Promise((resolve) => setTimeout(resolve, 120));
appendFileSync(${JSON.stringify(log)}, 'end ' + Date.now() + '\\n');
lease.release();
process.exit(0);
`;
    const run = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? -1));
      });
    assert.deepEqual(await Promise.all([run(), run()]), [0, 0]);
    const events = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [kind, at] = line.split(' ');
        return { kind, at: Number(at) };
      });
    assert.strictEqual(events.length, 4);
    const firstEnd = events.findIndex((e) => e.kind === 'end');
    const secondStart = events.findIndex((e, i) => i > firstEnd && e.kind === 'start');
    assert.ok(firstEnd >= 0 && secondStart > firstEnd, '第二个进程必须在第一个 end 之后才 start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
