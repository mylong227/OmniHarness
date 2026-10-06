import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgParser } from '../../src/cli/argParser.js';
import { KvStoreFactory } from '../../src/cli/kvStoreFactory.js';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.js';
import type { SandboxProfile } from '../../src/adapters/sandbox/sandboxManager.js';

/** 临时工作区（避免测试依赖真实 cwd）。 */
function testRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omni-enum-'));
}

test('非法 --sandbox 抛错而非静默回落 passthrough（fail-open 回归）', () => {
  // 拼错一个字母：修复前会经 `as` 强转穿过类型系统，
  // 再由 SandboxManager.build() 回落 PassthroughSandbox = 全放行。
  assert.throws(
    () => ArgParser.parseArgs(['--prompt', 'hi', '--sandbox', 'landock']),
    /非法参数值: --sandbox = landock/,
    '拼错的沙箱 profile 必须报错，绝不能静默变成全放行',
  );
});

test('非法 --elevated-sandbox 抛错（提权复核同样不容 fail-open）', () => {
  // 'restricted' 已是合法提权后端（见 ELEVATED_SANDBOXES），此处用真不在枚举内的值验 fail-closed。
  assert.throws(
    () => ArgParser.parseArgs(['--prompt', 'hi', '--elevated-sandbox', 'passthru']),
    /非法参数值: --elevated-sandbox = passthru/,
  );
});

test('其余安全/行为枚举参数全部严格校验', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['--approval', 'rulez'],
    ['--approval-ask', 'maybe'],
    ['--escalation', 'auto!'],
    ['--model-adapter', 'gpt'],
    ['--storage-adapter', 'mysql'],
    ['--spill-adapter', 'disk'],
    ['--events', 'verbose'],
  ];
  for (const [flag, value] of cases) {
    assert.throws(
      () => ArgParser.parseArgs(['--prompt', 'hi', flag, value]),
      new RegExp(`非法参数值: ${flag.replace('-', '\\-')} = ${value}`),
      `${flag} 应拒绝非法值 ${value}`,
    );
  }
});

test('错误提示列出可选值（可自愈，不留用户在黑暗里）', () => {
  try {
    ArgParser.parseArgs(['--prompt', 'hi', '--sandbox', 'nope']);
    assert.fail('应抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(
      message,
      /可选: passthrough \| policy \| restricted \| landlock \| seatbelt \| bwrap \| unshare/,
    );
  }
});

test('合法枚举值全部正常解析（无过度收紧）', () => {
  const sandboxProfiles = [
    'passthrough',
    'policy',
    'restricted',
    'landlock',
    'seatbelt',
    'bwrap',
    'unshare',
  ] as const;
  for (const profile of sandboxProfiles) {
    const args = ArgParser.parseArgs(['--prompt', 'hi', '--sandbox', profile]);
    assert.strictEqual(args?.sandbox, profile, `${profile} 应可正常解析`);
  }
  const mixed = ArgParser.parseArgs([
    '--prompt',
    'hi',
    '--approval',
    'guardian',
    '--approval-ask',
    'deny',
    '--escalation',
    'ask',
    '--elevated-sandbox',
    'policy',
    '--model-adapter',
    'llamacpp',
    '--storage-adapter',
    'sqlite',
    '--spill-adapter',
    'memory',
    '--events',
    'silent',
  ]);
  assert.strictEqual(mixed?.approval, 'guardian');
  assert.strictEqual(mixed?.approvalAsk, 'deny');
  assert.strictEqual(mixed?.escalation, 'ask');
  assert.strictEqual(mixed?.elevatedSandbox, 'policy');
  assert.strictEqual(mixed?.modelAdapter, 'llamacpp');
  assert.strictEqual(mixed?.storageAdapter, 'sqlite');
  assert.strictEqual(mixed?.spillAdapter, 'memory');
  assert.strictEqual(mixed?.events, 'silent');
});

test('SandboxManager 未知 profile 返回 fail-closed 后端（不再回落 passthrough）', async () => {
  const manager = new SandboxManager(testRoot());
  const backend = manager.build('landock' as unknown as SandboxProfile);
  assert.strictEqual(backend.name, 'landock', '后端名回显传入值，便于定位配置错误');
  const decision = await backend.check({ kind: 'command', target: 'rm -rf /' });
  assert.strictEqual(decision.allowed, false, '未知 profile 必须拒绝，绝不通行');
  assert.strictEqual(decision.category, 'os');
  assert.match(decision.reason ?? '', /未知沙箱 profile/);
});

test('SandboxManager 合法 profile 仍映射到对应后端（回归）', () => {
  const manager = new SandboxManager(testRoot());
  assert.strictEqual(manager.build('passthrough').name, 'passthrough');
  assert.strictEqual(manager.build('policy').name, 'policy');
  assert.strictEqual(manager.build('restricted').name, 'restricted');
});

test('非法数字参数抛错，绝不静默变成 NaN（"上限消失"是一种 fail-open）', () => {
  // 2026-10-06 排查发现：这些旗标此前用裸 `Number.parseInt` ⇒ `abc` 变 `NaN` ⇒
  // `--subagent-max-depth` 的深度闸 `depth >= maxDepth()` **恒为 false**（上限静默消失）、
  // `--cost-budget-usd` 让整段成本硬预算被丢掉（`NaN > 0` 为 false）。
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['--subagent-max-depth', 'abc'],
    ['--subagent-concurrency', 'many'],
    ['--cost-budget-usd', 'cheap'],
    ['--cost-budget-soft-ratio', ''],
    ['--compaction-max', '1e'],
  ];
  for (const [flag, value] of cases) {
    assert.throws(
      () => ArgParser.parseArgs(['--prompt', 'hi', flag, value]),
      /必须是有限数字/,
      `${flag} 应拒绝非数字 ${value}（静默 NaN = 上限失效）`,
    );
  }
  // 正对照：合法数字照常解析（小数与科学计数法都算数字）。
  const ok = ArgParser.parseArgs([
    '--prompt',
    'hi',
    '--subagent-max-depth',
    '3',
    '--cost-budget-usd',
    '1.5',
  ]);
  assert.strictEqual(ok?.subagentMaxDepth, 3);
  assert.strictEqual(ok?.costBudgetUsd, 1.5);
});

test('--kv-adapter 未知值抛错（此前静默回落到 json-file ⇒ 数据落错地方）', async () => {
  const factory = new KvStoreFactory();
  await assert.rejects(
    () => factory.createFor('sqlite3', join(tmpdir(), 'omni-kv-should-not-exist.json')),
    /非法 --kv-adapter/,
    '拼错的 KV 后端必须报错，不能静默读写 JSON 文件',
  );
  // 正对照 1：**省略**是文档化的默认（json-file），必须仍然可用——"拼错了"与"没传"是两件事。
  const defaulted = await factory.createFor(undefined, join(tmpdir(), 'omni-kv-default.json'));
  assert.ok(typeof defaulted.get === 'function' && typeof defaulted.set === 'function');
  // 正对照 2：合法枚举照常。
  const memory = await factory.createFor('memory', undefined);
  assert.ok(typeof memory.get === 'function');
});

test('--mock 是真实旗标（README 的 quick start 一直这么写，此前无人解析）', () => {
  // 修复前 `--mock` 不在 FLAG_TABLE，靠 `parseArgs` 对未知旗标静默 continue 才"看起来能用"
  // （因为缺省适配器本来就是 mock）——文档宣称的旗标必须真的存在。
  const args = ArgParser.parseArgs(['--prompt', 'hi', '--mock']);
  assert.strictEqual(args?.modelAdapter, 'mock');
  // 与 --model-adapter 同时给出时按 argv 顺序后者生效（可预测，不靠"谁先注册"）。
  const after = ArgParser.parseArgs(['--prompt', 'hi', '--mock', '--model-adapter', 'llamacpp']);
  assert.strictEqual(after?.modelAdapter, 'llamacpp');
  const before = ArgParser.parseArgs(['--prompt', 'hi', '--model-adapter', 'llamacpp', '--mock']);
  assert.strictEqual(before?.modelAdapter, 'mock');
});
