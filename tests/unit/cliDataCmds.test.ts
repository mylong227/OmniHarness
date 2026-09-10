import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * CLI 入口：以**子进程**驱动真实 CLI，而非在测试进程内劫持 process.stdout。
 * 原因（踩坑记录）：劫持 stdout 会与 node --test 的 TAP 报告器抢同一路 stdout，
 * 导致首个用例的结果行被吞、runner 少计一个用例。子进程方式无此冲突，且是更真实的端到端。
 */
const cliPath = resolve(process.cwd(), 'dist/src/cli/exec.js');

/** 以子进程运行 CLI，返回退出码与 stdout/stderr。 */
function runCli(args: readonly string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ── kv 端到端（覆盖 exec 分发 → CliDataCmds → StoreCommand → KvStoreFactory → CliArgReader 全链） ──

test('kv 端到端：set/get/list/del + 未找到（json-file 后端持久化）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-kv-'));
  const kvFile = join(dir, 'kv.json');
  try {
    const set = runCli(['kv', 'set', '--key', 'alpha', '--value', 'one', '--kv-file', kvFile]);
    assert.strictEqual(set.code, 0);
    assert.match(set.out, /已写入 alpha/);

    const get = runCli(['kv', 'get', '--key', 'alpha', '--kv-file', kvFile]);
    assert.strictEqual(get.code, 0);
    assert.strictEqual(get.out, 'one\n');

    const list = runCli(['kv', 'list', '--kv-file', kvFile]);
    assert.strictEqual(list.code, 0);
    assert.match(list.out, /alpha\tone/);

    const del = runCli(['kv', 'del', '--key', 'alpha', '--kv-file', kvFile]);
    assert.strictEqual(del.code, 0);
    assert.match(del.out, /已删除 alpha/);

    const miss = runCli(['kv', 'get', '--key', 'alpha', '--kv-file', kvFile]);
    assert.strictEqual(miss.code, 1, '未找到应返回退出码 1');
    assert.match(miss.out, /未找到: alpha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kv 位置参数回退：set 用 at(1)/at(2)，get 用 at(1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-kv-pos-'));
  const kvFile = join(dir, 'kv.json');
  try {
    const set = runCli(['kv', 'set', 'beta', 'two', '--kv-file', kvFile]);
    assert.strictEqual(set.code, 0);
    const get = runCli(['kv', 'get', 'beta', '--kv-file', kvFile]);
    assert.strictEqual(get.out, 'two\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 各命令用法路径（未知子命令 → 用法提示 + 退出码 2） ──

test('未知子命令一律返回退出码 2 并打印用法提示', () => {
  const cases: ReadonlyArray<readonly [string[], RegExp]> = [
    [['session', 'bogus'], /用法: omniharness session list/],
    [['kv', 'bogus', '--kv-adapter', 'memory'], /用法: omniharness kv get\|set\|del\|list/],
    [['audit', 'bogus'], /用法: omniharness audit export/],
    [['plugin', 'bogus'], /plugin load/],
    [['profile', 'bogus'], /profile list/],
    [['bundle', 'bogus'], /bundle pack/],
  ];
  for (const [argv, needle] of cases) {
    const r = runCli(argv);
    assert.strictEqual(r.code, 2, `${argv[0]} 未知子命令应返回退出码 2`);
    assert.match(r.out, needle, `${argv[0]} 应输出用法提示`);
  }
});
