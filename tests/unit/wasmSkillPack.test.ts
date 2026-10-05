/**
 * Wave C 产品工作判据：**wasm 技能包**——进化产物打成 `wasm-skill` 资产包，
 * 并在装包时**真在 wasm 档冒烟**（跑不起来就装不上）。
 *
 * ## 判据要钉死什么
 *
 * 1. **资产类型**：`wasm-skill` 默认 `evolved` + `wasm`；非法体当场拒（魔数不符 / 缺 entry / 负预算）；
 * 2. **造包往返**：`WasmSkillPack.build` → `AssetPackCodec.decode` ⇒ 条目数/名字/档位声明一致，
 *    且签名路径用**实际公钥**（不是清单里手写的那个）；
 * 3. **冒烟载荷与资产体同源**：`smokePayloadFor` 从**资产体**读 entry/input/fuel——
 *    装的时候跑什么，运行时就跑什么；缺 entry ⇒ **返回 undefined**（不凑默认值冒充）；
 * 4. **端到端装包**：用**真 wasm 产物**（`omni_wasm.wasm`）造包并装进能力注册表 ⇒ 成功；
 *    而**篡改过的模块字节**（破坏魔数/内容）⇒ 装包被拒且原因可读（这一条就是"装不上"的强制）；
 * 5. **未注册类型即拒**（J7 回归）：`schemaKind` 不在注册表 ⇒ 拒。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { WasmSkillSchema } from '../../src/capability/schemas/wasmSkillSchema.js';
import { WasmSkillPack } from '../../src/asset/wasmSkillPack.js';
import { AssetPackCodec } from '../../src/asset/assetPackCodec.js';
import { AssetPackInstaller } from '../../src/asset/assetPackInstaller.js';
import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import { CapabilityRegistry } from '../../src/capability/capabilityRegistry.js';
import { IsolationLadderFactory } from '../../src/adapters/isolation/isolationLadderFactory.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { CapabilityRecord } from '../../src/ports/capability.js';

/** 真 wasm 产物路径（与 `wasmKernelE2E` 同一份；缺则相关用例跳过并打印构建命令）。 */
const ARTIFACT = resolve(
  process.cwd(),
  'target',
  'wasm32-unknown-unknown',
  'release',
  'omni_wasm.wasm',
);
const BUILD_CMD = 'cargo build --release --target wasm32-unknown-unknown -p omni-wasm';

/** 最小合法 wasm 模块（`(module)`：8 字节头 + 无段）——用于不依赖 cargo 的类型/冒烟判据。 */
const EMPTY_MODULE = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * 造一个技能资产体（判据夹具）。
 * @param overrides 覆盖字段
 * @returns 资产体
 */
function assetOf(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: 'demo-skill',
    description: '演示技能',
    moduleBase64: Buffer.from(EMPTY_MODULE).toString('base64'),
    entry: 'process',
    input: '{"method":"ping"}',
    fuel: 1000,
    ...overrides,
  };
}

/**
 * 造一条待装资产记录。
 * @param asset 资产体
 * @returns 记录
 */
function recordOf(asset: unknown): CapabilityRecord {
  // 按**真实契约**造记录：`{ asset, schemaKind, lineage, fitness, governance }`。
  // （判据第一版按"扁平字段"造，TS 当场拒绝——契约比印象靠谱。）
  return {
    asset,
    schemaKind: 'wasm-skill',
    lineage: { parents: [], operator: 'wasm-pack', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: {
      trustTier: 'evolved',
      isolation: 'wasm',
      state: 'active',
      ledgerSeq: undefined,
    },
  } satisfies CapabilityRecord;
}

/**
 * 造一个装配好的安装器（真隔离阶梯 + wasm 冒烟）。
 * @returns 安装器与注册表
 */
function installerOf(): {
  readonly installer: AssetPackInstaller;
  readonly registry: CapabilityRegistry;
} {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new WasmSkillSchema());
  const registry = new CapabilityRegistry({
    schemas,
    skills: new SkillRegistry(),
  });
  const installer = new AssetPackInstaller({
    registry,
    schemas,
    // **台账必配**：安装要落哈希链（治理口径"无台账不生效"）。判据第一版漏了它，
    // 于是被拒的原因是台账缺失而不是被冒烟拦下——夹具错了会让判据测错东西。
    ledger: new HashChainPromotionLedger({
      dir: mkdtempSync(join(tmpdir(), 'wasm-skill-ledger-')),
      now: () => '2026-10-04T00:00:00.000Z',
    }),
    defaults: { trustTier: 'evolved', isolation: 'vm' },
    isolation: IsolationLadderFactory.builtin({ timeoutMs: 10_000 }),
    smokePayloadFor: (record) => WasmSkillPack.smokePayloadFor(record),
  });
  return { installer, registry };
}

test('Wave C 资产类型：wasm-skill 默认 evolved + wasm；非法体当场拒（魔数/入口/预算）', () => {
  const schema = new WasmSkillSchema();
  assert.strictEqual(schema.kind, 'wasm-skill');
  assert.strictEqual(schema.defaultTrustTier, 'evolved');
  assert.strictEqual(schema.defaultIsolation, 'wasm');
  assert.deepStrictEqual(schema.validate(assetOf()), { ok: true });

  const bad: readonly (readonly [unknown, RegExp])[] = [
    [assetOf({ moduleBase64: '' }), /moduleBase64/],
    [
      assetOf({ moduleBase64: Buffer.from('not wasm at all').toString('base64') }),
      /魔数不符|不是 wasm/,
    ],
    [assetOf({ entry: '' }), /entry/],
    [assetOf({ fuel: 0 }), /fuel/],
    [assetOf({ name: '' }), /name/],
    ['not-an-object', /必须是对象/],
  ];
  for (const [asset, pattern] of bad) {
    const verdict = schema.validate(asset);
    assert.strictEqual(verdict.ok, false, `应拒绝：${JSON.stringify(asset).slice(0, 60)}`);
    if (!verdict.ok) assert.match(verdict.reason, pattern);
  }

  // 评估合同：结构合法 0.5 + 入口 0.25 + 预算 0.25（不假装知道模块能否跑——那属冒烟那一步）。
  const benchmark = schema.evalContract({} as never);
  assert.strictEqual(benchmark(assetOf()), 1);
  assert.strictEqual(benchmark(assetOf({ entry: undefined, fuel: undefined })), 0.5);
  assert.strictEqual(benchmark({ bad: true }), 0);
});

test('Wave C 造包往返：条目/档位声明一致，签名用实际公钥（不是清单手写的那个）', () => {
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'wasm-publisher' });
  const bytes = WasmSkillPack.build({
    name: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    skills: [
      { name: 's1', description: '技能一', moduleBytes: EMPTY_MODULE },
      {
        name: 's2',
        description: '技能二',
        moduleBytes: EMPTY_MODULE,
        entry: 'run',
        input: '{"method":"tools.list"}',
        fuel: 2000,
      },
    ],
    publisher: { runtimeId: 'wasm-publisher', identity },
  });
  const manifest = AssetPackCodec.decode(bytes);
  assert.strictEqual(manifest.name, 'demo-pack');
  assert.strictEqual(manifest.assets.length, 2);
  assert.deepStrictEqual(
    manifest.assets.map((entry) => entry.name),
    ['s1', 's2'],
  );
  for (const entry of manifest.assets) {
    assert.strictEqual(entry.schemaKind, 'wasm-skill');
    assert.strictEqual(entry.governance?.isolation, 'wasm', '档位声明必须进包');
    assert.strictEqual(entry.governance?.trustTier, 'evolved');
  }
  // 签名绑定**实际公钥**：手写一个不同的 publisher 也不会改变验签结果。
  assert.strictEqual(manifest.publisher.publicKeySsh, identity.publicKeySsh());
  assert.strictEqual(manifest.signature !== undefined, true);
  assert.strictEqual(AssetPackCodec.verify(manifest).ok, true, '自签的包必须自验通过');
  // 篡改正文 ⇒ 验签失败（J9 口径在 wasm 技能包上同样成立）。
  const tampered = { ...manifest, name: 'evil-pack' };
  assert.strictEqual(AssetPackCodec.verify(tampered).ok, false);
});

test('Wave C 冒烟载荷同源：entry/input/fuel 取自资产体；缺 entry 返回 undefined（不冒充）', () => {
  const payload = WasmSkillPack.smokePayloadFor(recordOf(assetOf({ entry: 'run', fuel: 42 })));
  assert.ok(payload !== undefined);
  assert.strictEqual(payload.kind, 'wasm-module');
  assert.strictEqual(payload.entry, 'run');
  assert.strictEqual(payload.fuel, 42);
  assert.deepStrictEqual([...(payload as { bytes: Uint8Array }).bytes], [...EMPTY_MODULE]);

  // 缺 entry ⇒ undefined（凑一个默认入口可能恰好能跑，从而掩盖"资产没声明入口"）。
  assert.strictEqual(
    WasmSkillPack.smokePayloadFor(recordOf(assetOf({ entry: undefined }))),
    undefined,
  );
  // 非本类型 ⇒ undefined（不替别的类型造载荷）。
  assert.strictEqual(
    WasmSkillPack.smokePayloadFor({
      ...recordOf(assetOf()),
      schemaKind: 'skill',
    } as CapabilityRecord),
    undefined,
  );
});

test('Wave C 端到端装包：真 wasm 产物装进注册表；**篡改模块即拒装**（跑不起来就装不上）', async (t) => {
  if (!existsSync(ARTIFACT)) {
    t.skip(`缺 wasm 产物，先执行：${BUILD_CMD}`);
    return;
  }
  const moduleBytes = readFileSync(ARTIFACT);
  // 签名（生产口径：装包路径会校验发布者公钥，匿名占位键会被拒）。
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'wasm-skill-publisher' });
  const goodPack = WasmSkillPack.build({
    name: 'kernel-skill-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    publisher: { runtimeId: 'wasm-skill-publisher', identity },
    skills: [
      {
        name: 'wasm-kernel',
        description: '真 wasm 内核（206 KB）',
        moduleBytes,
        entry: 'process',
        input: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        fuel: 1_000_000,
      },
    ],
  });

  // ① 正常装：冒烟在 wasm 档真跑 `ping` ⇒ 装成功并进注册表。
  const ok = installerOf();
  const report = await ok.installer.install({ bytes: goodPack, requireSignature: true });
  assert.strictEqual(report.ok, true, JSON.stringify(report));
  assert.deepStrictEqual(report.installed, ['wasm-kernel']);
  const records = ok.registry.recordsOfKind('wasm-skill');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0]?.governance.isolation, 'wasm', '装进来的资产必须带 wasm 档声明');

  // ② 篡改模块字节（破坏 C-ABI 导出）⇒ 冒烟跑不起来 ⇒ **装包被拒**且原因可读。
  const brokenBytes = Buffer.from(moduleBytes);
  // 把模块尾部截掉一段：足以让实例化/入口查找失败，但仍是"看起来像 wasm"的字节。
  const truncated = brokenBytes.subarray(0, Math.max(64, Math.floor(brokenBytes.length * 0.6)));
  const badPack = WasmSkillPack.build({
    name: 'broken-skill-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    publisher: { runtimeId: 'wasm-skill-publisher', identity },
    skills: [
      {
        name: 'broken-kernel',
        description: '被截断的模块',
        moduleBytes: truncated,
        entry: 'process',
        input: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        fuel: 1_000_000,
      },
    ],
  });
  const bad = installerOf();
  const badReport = await bad.installer.install({ bytes: badPack, requireSignature: true });
  assert.strictEqual(badReport.ok, false, '跑不起来的模块不得装进注册表');
  assert.strictEqual(
    bad.registry.recordsOfKind('wasm-skill').length,
    0,
    '被拒的包不得留下任何资产',
  );
});

test('Wave C 未注册类型即拒（J7 回归）：schemaKind 不在注册表 ⇒ 装包被拒', async () => {
  const { installer } = installerOf();
  // 手搓一个 kind 未注册的包（`WasmSkillPack` 只造本类型，故这里直接编清单）。
  const manifest = {
    format: 'omniharness-asset-pack' as const,
    version: 1 as const,
    name: 'unregistered-pack',
    publisher: { runtimeId: 'x', publicKeySsh: 'ssh-ed25519 AAAA' },
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [
      {
        schemaKind: 'not-registered',
        name: 'ghost',
        asset: assetOf(),
        governance: { trustTier: 'evolved' as const, isolation: 'wasm' as const },
      },
    ],
  };
  const report = await installer.install({
    bytes: AssetPackCodec.encode(manifest),
    requireSignature: false,
  });
  assert.strictEqual(report.ok, false);
  assert.ok(report.installed.length === 0);
  // 存储端口保持注入（`MemoryStorage` 仅用于占位：本判据不落盘任何资产）。
  void new MemoryStorage();
});
