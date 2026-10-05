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
import { AssetPackCodec } from '../../src/asset/assetPackCodec.js';
import { AssetPackInstaller } from '../../src/asset/assetPackInstaller.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { CapabilityStackAssembler } from '../../src/config/capabilityStackAssembler.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { AssetPackManifest, PackAssetEntry } from '../../src/ports/asset.js';
import type { CapabilityRegistryPort } from '../../src/ports/capability.js';
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
  assert.match(first.out, /资产协议：3 个类型/);
  assert.match(first.out, /skill（v1）：资产 1/);
  assert.match(first.out, /workflow-template（v1）：资产 0/);
  assert.match(first.out, /wasm-skill（v1）：资产 0 ｜ 默认档 evolved\/wasm/);
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
      // (Wave C) wasm 技能类型已出厂注册（本夹具里资产数为 0）。
      ['wasm-skill', 0],
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
  const { out, result } = await capture(() => command.run(['bogus']));
  assert.strictEqual(result, 2);
  assert.match(out, /omniharness capability list/);
});

// ---- Wave D3：install / metadata ----

/**
 * 造一条技能资产条目。
 * @param name 资产名
 * @returns PackAssetEntry
 */
function packSkillEntry(name: string): PackAssetEntry {
  return {
    schemaKind: 'skill',
    name,
    asset: { name, description: `${name} 描述`, instructions: `${name} 步骤。` },
  };
}

/**
 * 建一套安装环境（切片 + 安装器 + 包文件）。
 * @param signed 包是否签名
 * @returns 环境（含包文件路径、注册表、台账与目录）
 */
async function installEnv(signed: boolean): Promise<{
  readonly command: CapabilityCommand;
  readonly packPath: string;
  readonly ledger: HashChainPromotionLedger;
  readonly registry: CapabilityRegistryPort;
  readonly dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-pack-cli-'));
  const ledger = new HashChainPromotionLedger({ dir, now: () => '2026-10-04T00:00:00.000Z' });
  // 与生产同构：安装器用**切片里那份**注册表与类型表（各起一套的话，装完的资产在只读面上看不见——
  // 片开发期真实踩到，本判据当场变红）。
  const stack = CapabilityStackAssembler.assemble({
    skillRegistry: new SkillRegistry(),
    config: { enabled: true },
  });
  assert.ok(stack !== undefined);
  const installer = new AssetPackInstaller({
    registry: stack.registry,
    schemas: stack.schemas,
    ledger,
    defaults: stack.defaults,
    now: () => '2026-10-04T00:00:00.000Z',
  });
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-cli' });
  const base: AssetPackManifest = {
    format: 'omniharness-asset-pack',
    version: 1,
    name: 'cli-pack',
    publisher: { runtimeId: publisher.runtimeId(), publicKeySsh: publisher.publicKeySsh() },
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [packSkillEntry('cli-asset')],
  };
  const manifest = signed ? AssetPackCodec.sign(base, publisher) : base;
  const packPath = join(dir, 'pack.ohb');
  writeFileSync(packPath, AssetPackCodec.encode(manifest));
  return {
    command: new CapabilityCommand(
      () => stack,
      () => installer,
    ),
    packPath,
    ledger,
    registry: stack.registry,
    dir,
  };
}

test('D3 install 门禁：缺 --yes 即拒（退出码 2）且零改动', async () => {
  const env = await installEnv(true);
  const before = readdirSync(env.dir).sort();
  const { err, result } = await capture(() => env.command.run(['install', env.packPath]));
  assert.strictEqual(result, 2);
  assert.match(err, /必须显式加 --yes/);
  assert.strictEqual(env.ledger.list().length, 0, '被拒的安装不得入账');
  assert.deepStrictEqual(readdirSync(env.dir).sort(), before, '被拒的安装不得新增文件');
});

test('D3 install --yes：签名包入册 + 入账，报告可机读', async () => {
  const env = await installEnv(true);
  const { out, result } = await capture(() =>
    env.command.run(['install', env.packPath, '--yes', '--json']),
  );
  assert.strictEqual(result, 0);
  const report = JSON.parse(out.trim()) as {
    ok: boolean;
    installed: number;
    assets: string[];
    publisher: string;
    ledgerSeq: number;
  };
  assert.deepStrictEqual(
    {
      ok: report.ok,
      installed: report.installed,
      assets: report.assets,
      publisher: report.publisher,
    },
    { ok: true, installed: 1, assets: ['cli-asset'], publisher: 'pub-cli' },
  );
  assert.strictEqual(report.ledgerSeq, 1);
  assert.strictEqual(env.registry.recordOf('cli-asset')?.governance.trustTier, 'evolved');
  assert.strictEqual(env.ledger.list().filter((e) => e.action === 'pack-install').length, 1);
});

test('D3 install 严格档：无签名包拒装（退出码 1）且原因可读；--allow-unsigned 才收', async () => {
  const strict = await installEnv(false);
  const rejected = await capture(() => strict.command.run(['install', strict.packPath, '--yes']));
  assert.strictEqual(rejected.result, 1);
  assert.match(rejected.err, /拒装：验签未通过（unsigned）/);
  assert.strictEqual(strict.ledger.list().length, 0);

  const lenient = await installEnv(false);
  const accepted = await capture(() =>
    lenient.command.run(['install', lenient.packPath, '--yes', '--allow-unsigned', '--json']),
  );
  assert.strictEqual(accepted.result, 0);
  const report = JSON.parse(accepted.out.trim()) as { unsigned?: boolean };
  assert.strictEqual(report.unsigned, true, '未签名必须如实申报');
  assert.strictEqual(
    lenient.registry.recordOf('cli-asset')?.governance.trustTier,
    'external',
    '未签名包按最不信档起算',
  );
});

test('D3 install 未接线 / 包不存在：如实报错（退出码 2 / 1），不假装成功', async () => {
  const unwired = new CapabilityCommand(() => stackOf());
  const noInstaller = await capture(() => unwired.run(['install', 'x.ohb', '--yes']));
  assert.strictEqual(noInstaller.result, 2);
  assert.match(noInstaller.err, /未接线/);

  const env = await installEnv(true);
  const missing = await capture(() =>
    env.command.run(['install', join(env.dir, 'nope.ohb'), '--yes']),
  );
  assert.strictEqual(missing.result, 1);
  assert.match(missing.err, /无法读取资产包/);
});

test('D3 metadata（只读）：--kind 单类型 / 全类型，且不写任何状态', async () => {
  const env = await installEnv(true);
  await env.command.run(['install', env.packPath, '--yes']);
  const before = readdirSync(env.dir).sort();
  const ledgerBefore = env.ledger.list().length;

  const one = await capture(() => env.command.run(['metadata', '--kind', 'skill', '--json']));
  assert.strictEqual(one.result, 0);
  const metadata = JSON.parse(one.out.trim()) as {
    kind: string;
    assets: { name: string }[];
  }[];
  assert.strictEqual(metadata.length, 1);
  assert.strictEqual(metadata[0]?.kind, 'skill');
  assert.deepStrictEqual(
    metadata[0]?.assets.map((a) => a.name),
    ['cli-asset'],
  );
  assert.ok(!one.out.includes('步骤'), '元数据不得带 instructions 明文');

  const all = await capture(() => env.command.run(['metadata', '--json']));
  assert.strictEqual(all.result, 0);
  // (Wave C) 出厂三类（skill / wasm-skill / workflow-template）。
  assert.strictEqual((JSON.parse(all.out.trim()) as unknown[]).length, 3, '缺省列全类型');

  const unknown = await capture(() => env.command.run(['metadata', '--kind', 'operator']));
  assert.strictEqual(unknown.result, 1);
  assert.match(unknown.err, /类型未注册：operator/);

  assert.strictEqual(env.ledger.list().length, ledgerBefore, '只读命令不得入账');
  assert.deepStrictEqual(readdirSync(env.dir).sort(), before, '只读命令不得新增文件');
});

test('D3 install 用法：缺包路径 ⇒ 用法 + 退出码 2', async () => {
  const env = await installEnv(true);
  const { out, result } = await capture(() => env.command.run(['install', '--yes']));
  assert.strictEqual(result, 2);
  assert.match(out, /omniharness capability install/);
});
