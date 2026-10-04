/**
 * Wave B6（ADR-0009）：`capability list` 子命令判据。
 *
 * 判据口径：
 * - **只读**：命令类只拿到「取切片」的只读回调 ⇒ 跑完技能表与台账文件逐字节不变；
 * - **未启用如实报错**（退出码 1），而不是打一张空表让人以为「协议在跑只是没资产」；
 * - 输出确定性（同一切片恒同输出）+ `--json` 结构可机读；
 * - 未知子命令 ⇒ 用法 + 退出码 2（不误当主任务执行）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CapabilityCommand } from '../../src/cli/capabilityCommand.js';
import { CapabilityStackAssembler } from '../../src/config/capabilityStackAssembler.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { CapabilityStack } from '../../src/ports/config/capabilityStack.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 采集 stdout/stderr（命令协作者按 CLI 契约写这两条流）。
 * @param run 被测动作
 * @returns 两条流文本与结果
 */
async function capture<T>(
  run: () => Promise<T>,
): Promise<{ readonly out: string; readonly err: string; readonly result: T }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await run();
    return { out: outChunks.join(''), err: errChunks.join(''), result };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/**
 * 造一个开启的资产协议切片（含一条技能资产）。
 * @returns 切片
 */
function stackOf(): CapabilityStack {
  const registry = new SkillRegistry();
  const skill: Skill = { name: 'seed', description: 'd', instructions: 'i' };
  registry.register(skill);
  const stack = CapabilityStackAssembler.assemble({
    skillRegistry: registry,
    config: { enabled: true },
  });
  assert.ok(stack !== undefined);
  stack.registry.put({
    asset: skill,
    schemaKind: 'skill',
    lineage: { parents: [], operator: 'test', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: {
      trustTier: 'core',
      isolation: 'os-sandbox',
      state: 'active',
      ledgerSeq: undefined,
    },
  });
  return stack;
}

test('B6 capability list（文本）：列类型 / 资产数 / 生效档位，且确定性', async () => {
  const command = new CapabilityCommand(() => stackOf());
  const first = await capture(() => command.run(['list']));
  assert.strictEqual(first.result, 0);
  assert.match(first.out, /资产协议：2 个类型/);
  assert.match(first.out, /skill（v1）：资产 1/);
  assert.match(first.out, /workflow-template（v1）：资产 0/);
  assert.match(first.out, /生效档位下限：evolved\/vm/);
  const second = await capture(() => command.run(['list']));
  assert.strictEqual(second.out, first.out, '同一切片恒同输出（确定性）');
});

test('B6 capability list（--json）：结构可机读且与文本同源', async () => {
  const command = new CapabilityCommand(() => stackOf());
  const { out, result } = await capture(() => command.run(['list', '--json']));
  assert.strictEqual(result, 0);
  const parsed = JSON.parse(out.trim()) as {
    kinds: { kind: string; assets: number; defaultTrustTier: string }[];
    skills: number;
    defaults: { trustTier: string; isolation: string };
  };
  assert.deepStrictEqual(
    parsed.kinds.map((k) => [k.kind, k.assets]),
    [
      ['skill', 1],
      ['workflow-template', 0],
    ],
  );
  assert.strictEqual(parsed.skills, 1);
  assert.deepStrictEqual(parsed.defaults, { trustTier: 'evolved', isolation: 'vm' });
});

test('B6 未启用如实报错（退出码 1），不打空表冒充「协议在跑」', async () => {
  const command = new CapabilityCommand(() => undefined);
  const { out, err, result } = await capture(() => command.run(['list']));
  assert.strictEqual(result, 1);
  assert.strictEqual(out, '', '未启用时不得打印看似正常的表');
  assert.match(err, /capability 未启用/);
});

test('B6 只读（结构性）：跑完技能表与台账文件逐字节不变、目录零新增', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-cap-cli-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  const ledger = new HashChainPromotionLedger({ dir, now: () => '2026-10-04T00:00:00.000Z' });
  ledger.snapshotBefore([]);
  writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8'), 'utf8');
  const before = readFileSync(ledgerPath, 'utf8');
  const filesBefore = readdirSync(dir).sort();

  const stack = stackOf();
  const skillsBefore = stack.registry.list().map((s) => s.name);
  const command = new CapabilityCommand(() => stack);
  const { result } = await capture(() => command.run(['list']));
  assert.strictEqual(result, 0);
  assert.deepStrictEqual(
    stack.registry.list().map((s) => s.name),
    skillsBefore,
    '只读命令不得改动技能表',
  );
  assert.strictEqual(readFileSync(ledgerPath, 'utf8'), before, '只读命令不得改台账');
  assert.deepStrictEqual(readdirSync(dir).sort(), filesBefore, '只读命令不得新增文件');
});

test('B6 未知子命令：打印用法并退出 2（不误当主任务执行）', async () => {
  const command = new CapabilityCommand(() => stackOf());
  const { out, result } = await capture(() => command.run(['install']));
  assert.strictEqual(result, 2, 'install 属 Wave D，本波如实报用法错误');
  assert.match(out, /omniharness capability list/);
});
