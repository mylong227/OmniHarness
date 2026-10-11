import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cliRunner.js';

// CLI 子进程驱动见 `tests/helpers/cliRunner.ts`（2026-10-11 抽出，供本文件与 cliBoostCmds 共用）。

// ── kv 端到端（覆盖 exec 分发 → CliDataCmds → StoreCommand → KvStoreFactory → CliArgReader 全链） ──

test('kv 端到端：set/get/list/del + 未找到（json-file 后端持久化）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-kv-'));
  const kvFile = join(dir, 'kv.json');
  try {
    const set = await runCli([
      'kv',
      'set',
      '--key',
      'alpha',
      '--value',
      'one',
      '--kv-file',
      kvFile,
    ]);
    assert.strictEqual(set.code, 0);
    assert.match(set.out, /已写入 alpha/);

    const get = await runCli(['kv', 'get', '--key', 'alpha', '--kv-file', kvFile]);
    assert.strictEqual(get.code, 0);
    assert.strictEqual(get.out, 'one\n');

    const list = await runCli(['kv', 'list', '--kv-file', kvFile]);
    assert.strictEqual(list.code, 0);
    assert.match(list.out, /alpha\tone/);

    const del = await runCli(['kv', 'del', '--key', 'alpha', '--kv-file', kvFile]);
    assert.strictEqual(del.code, 0);
    assert.match(del.out, /已删除 alpha/);

    const miss = await runCli(['kv', 'get', '--key', 'alpha', '--kv-file', kvFile]);
    assert.strictEqual(miss.code, 1, '未找到应返回退出码 1');
    assert.match(miss.out, /未找到: alpha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kv 位置参数回退：set 用 at(1)/at(2)，get 用 at(1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-kv-pos-'));
  const kvFile = join(dir, 'kv.json');
  try {
    const set = await runCli(['kv', 'set', 'beta', 'two', '--kv-file', kvFile]);
    assert.strictEqual(set.code, 0);
    const get = await runCli(['kv', 'get', 'beta', '--kv-file', kvFile]);
    assert.strictEqual(get.out, 'two\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 各命令用法路径（未知子命令 → 用法提示 + 退出码 2） ──

test('未知子命令一律返回退出码 2 并打印用法提示', async () => {
  const cases: ReadonlyArray<readonly [string[], RegExp]> = [
    [['session', 'bogus'], /用法: omniharness session list/],
    [['kv', 'bogus', '--kv-adapter', 'memory'], /用法: omniharness kv get\|set\|del\|list/],
    [['audit', 'bogus'], /用法: omniharness audit export/],
    [['plugin', 'bogus'], /plugin load/],
    [['profile', 'bogus'], /profile list/],
    [['bundle', 'bogus'], /bundle pack/],
  ];
  for (const [argv, needle] of cases) {
    const r = await runCli(argv);
    assert.strictEqual(r.code, 2, `${argv[0]} 未知子命令应返回退出码 2`);
    assert.match(r.out, needle, `${argv[0]} 应输出用法提示`);
  }
});
