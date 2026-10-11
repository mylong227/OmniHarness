import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncAsync } from '../helpers/childProcess.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * CLI 入口：以**子进程**驱动真实 CLI，而非在测试进程内劫持 process.stdout。
 * 原因（踩坑记录）：劫持 stdout 会与 node --test 的 TAP 报告器抢同一路 stdout，
 * 导致首个用例的结果行被吞、runner 少计一个用例。子进程方式无此冲突，且是更真实的端到端。
 */
const cliPath = resolve(process.cwd(), 'dist/src/cli/exec.js');

/** 以子进程运行 CLI，返回退出码与 stdout/stderr。 */
async function runCli(
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const r = await spawnSyncAsync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

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

// ── boost 子命令分发（2026-10-11 补：该子命令引入时 +79 行无判据，覆盖率门禁因此回退 22.6 点） ──

test('boost：用法错误与非法取值一律返回退出码 2（不静默当成 probe 跑）', async () => {
  const bogusAction = await runCli(['boost', 'bogus-action']);
  assert.strictEqual(bogusAction.code, 2, '未知子动作应返回 2');
  assert.match(bogusAction.err, /用法: omniharness boost probe/, '应打印 boost 用法');

  const badTier = await runCli(['boost', 'gate', '--boost-tier', 'nope']);
  assert.strictEqual(badTier.code, 2, '非法 --boost-tier 应返回 2（枚举 fail-closed）');

  const badMode = await runCli(['boost', 'gate', '--boost-mode', 'nope']);
  assert.strictEqual(badMode.code, 2, '非法 --boost-mode 应返回 2');
});

test('boost probe list：列出探针而**不执行**它们（位置参数口径，帮助里写的就是它）', async () => {
  const r = await runCli(['boost', 'probe', 'list']);
  assert.strictEqual(r.code, 0, `boost probe list 应成功，stderr=${r.err}`);
  assert.match(r.out, /发现 \d+ 个探针|recallHitrate/, `应列出探针清单：${r.out.slice(0, 300)}`);
  // **核心判据**：这条命令只许"看"，不许"跑"——旧实现把位置参数静默忽略，
  // 于是 `boost probe list` 跑完全部探针（实测 70 秒），而调用方以为只是列清单。
  assert.ok(
    !/通过 \(exit=/.test(r.out),
    `boost probe list 不得执行探针（输出里出现了执行结果）：${r.out.slice(0, 300)}`,
  );
});

test('boost probe list：位置参数与 --boost-list 两种写法等价，且取值型旗标都能被读到', async () => {
  const r = await runCli([
    'boost',
    'probe',
    'list',
    '--boost-probe',
    'recallHitrate,toolExposureBudget',
    '--boost-arg',
    'k=v',
    '--boost-network',
    '--boost-diff',
    '--boost-timeout-ms',
    '1000',
  ]);
  assert.strictEqual(r.code, 0, `带全量旗标的 list 仍应成功，stderr=${r.err}`);
  assert.ok(!/通过 \(exit=/.test(r.out), '仍不得执行探针');

  const flagForm = await runCli(['boost', 'probe', '--boost-list']);
  assert.strictEqual(flagForm.code, 0, `--boost-list 也应成功，stderr=${flagForm.err}`);
  assert.ok(!/通过 \(exit=/.test(flagForm.out), '--boost-list 同样只列不跑');
});

test('boost probe：未知位置参数与未知探针一律退出码 2（fail-closed，不静默当 probe 跑）', async () => {
  const badPositional = await runCli(['boost', 'probe', 'bogus']);
  assert.strictEqual(badPositional.code, 2, '未知位置参数应返回 2（旧实现会静默忽略并跑探针）');

  const unknownProbe = await runCli([
    'boost',
    'probe',
    'list',
    '--boost-probe',
    '__no_such_probe__',
  ]);
  assert.strictEqual(unknownProbe.code, 2, '未知探针应返回 2');
});

test('boost gate（不执行）：报告"该跑什么"并落 gate-decision.json（绝对路径也要解析对）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-boost-gate-'));
  try {
    const r = await runCli([
      'boost',
      'gate',
      '--boost-mode',
      'worktree',
      '--boost-explain',
      '--boost-dir',
      dir,
    ]);
    assert.ok(
      r.code === 0 || r.code === 3,
      `boost gate（不跑）应为 0 或 3，实为 ${String(r.code)}；stderr=${r.err}`,
    );
    assert.ok(
      existsSync(join(dir, 'gate-decision.json')),
      '--boost-dir 给了就必须落 gate-decision.json',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boost audit-surface：真读门禁清单并落快照（0=无过期 / 3=需重新取证）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-boost-'));
  try {
    const r = await runCli(['boost', 'audit-surface', '--boost-dir', dir]);
    assert.ok(
      r.code === 0 || r.code === 3,
      `退出码应为 0（无过期）或 3（需重新取证），实为 ${String(r.code)}；stderr=${r.err}`,
    );
    // 自证"没静默什么都不做"：快照必须真的落盘（否则这条判据可以被"直接 return 0"骗过）
    assert.ok(
      existsSync(join(dir, 'gate-surface.json')),
      `必须写出快照 gate-surface.json，实际目录内容：${String(existsSync(dir))}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
