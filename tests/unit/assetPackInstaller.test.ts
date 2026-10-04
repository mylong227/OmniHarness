/**
 * Wave D2（ADR-0011 · EVOLVIX_SPEC §4 F3 + §8 J9）：签名资产包**安装流水线**判据。
 *
 * 判据口径（每条都对应一句可证伪的声明）：
 * 1. **严格档默认**：无签名包 ⇒ 整包拒（J9-①）；显式 `requireSignature:false` 才收，且如实标 `unsigned`
 *    并把信任档按 `external` 起算（不假装签过名）；
 * 2. **整包原子**：任一资产校验不过 / 类型未注册 / 重名 / 档位请求放宽 ⇒ 整包拒，**一条都不入册、一条账都不留**；
 * 3. **档位只收紧**：请求更严 ⇒ 生效；请求更松 ⇒ 拒（不静默取交集）；
 * 4. **无账不生效**：没有台账 ⇒ 拒装（即使包完全合法）；
 * 5. **逐资产入账**：安装成功 ⇒ 每个资产一条 `pack-install` 条目，链验签仍绿；
 * 6. **元数据导出**：`metadataFor` 只出公开字段（不含 instructions 明文）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AssetPackCodec } from '../../src/asset/assetPackCodec.js';
import { AssetPackInstaller } from '../../src/asset/assetPackInstaller.js';
import { CapabilityRegistry } from '../../src/capability/capabilityRegistry.js';
import { CapabilitySchemaRegistry } from '../../src/capability/capabilitySchemaRegistry.js';
import { SkillSchema } from '../../src/capability/schemas/skillSchema.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { IsolationLadder } from '../../src/adapters/isolation/isolationLadder.js';
import { Zip } from '../../src/plugin/zip.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { AssetPackManifest, PackAssetEntry } from '../../src/ports/asset.js';
import type { CapabilityRegistryPort, IsolationLevel } from '../../src/ports/capability.js';
import type { IsolationPort } from '../../src/ports/runtime/isolation.js';

/** 固定时钟（确定性）。 */
const FIXED_NOW = (): string => '2026-10-04T00:00:00.000Z';

/**
 * 造一条技能资产条目。
 * @param name 资产名
 * @param governance 治理请求（可选）
 * @returns PackAssetEntry
 */
function skillEntry(name: string, governance?: PackAssetEntry['governance']): PackAssetEntry {
  return {
    schemaKind: 'skill',
    name,
    asset: { name, description: `${name} 描述`, instructions: `${name} 步骤。` },
    parents: ['a', 'b'],
    operator: 'twist:a+b',
    ...(governance !== undefined ? { governance } : {}),
  };
}

/**
 * 造一份（可签名的）清单。
 * @param name 包名
 * @param assets 资产条目
 * @param signed 是否签名
 * @returns 清单
 */
function manifestOf(
  name: string,
  assets: readonly PackAssetEntry[],
  signed: boolean,
): { readonly manifest: AssetPackManifest; readonly bytes: Buffer } {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const base: AssetPackManifest = {
    format: 'omniharness-asset-pack',
    version: 1,
    name,
    publisher: { runtimeId: publisher.runtimeId(), publicKeySsh: publisher.publicKeySsh() },
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets,
  };
  const manifest = signed ? AssetPackCodec.sign(base, publisher) : base;
  return { manifest, bytes: AssetPackCodec.encode(manifest) };
}

/**
 * 建一套安装环境（注册表 / 类型注册表 / 台账 / 安装器）。
 * @param withLedger 是否注入台账
 * @returns 环境
 */
function env(withLedger = true): {
  readonly installer: AssetPackInstaller;
  readonly registry: CapabilityRegistry;
  readonly ledger?: HashChainPromotionLedger;
} {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  const skills = new SkillRegistry();
  const ledger = withLedger ? new HashChainPromotionLedger({ now: FIXED_NOW }) : undefined;
  const registry = new CapabilityRegistry({
    schemas,
    skills,
    ...(ledger !== undefined ? { ledger } : {}),
  });
  const installer = new AssetPackInstaller({
    registry,
    schemas,
    ledger,
    defaults: { trustTier: 'evolved', isolation: 'vm' },
    now: FIXED_NOW,
  });
  return { installer, registry, ...(ledger !== undefined ? { ledger } : {}) };
}

test('D2 J9-① 严格档默认：无签名包整包拒（零入册、零账目）', async () => {
  const { installer, registry, ledger } = env();
  const { bytes } = manifestOf('unsigned-pack', [skillEntry('u1')], false);
  const report = await installer.install({ bytes });
  assert.strictEqual(report.ok, false);
  assert.match(report.rejectedReason ?? '', /验签未通过（unsigned）/);
  assert.deepStrictEqual(report.installed, []);
  assert.strictEqual(registry.recordOf('u1'), undefined, '被拒的包不得留下任何资产');
  assert.strictEqual(ledger!.list().length, 0, '被拒的包不得留下任何账目');
});

test('D2 非严格档：收无签名包但如实标 unsigned，信任档按 external 起算', async () => {
  const { installer, ledger } = env();
  const { bytes } = manifestOf('dev-pack', [skillEntry('d1')], false);
  const report = await installer.install({ bytes, requireSignature: false });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.unsigned, true, '必须如实申报未签名');
  assert.strictEqual(
    installer.metadataFor('skill')?.assets.find((a) => a.name === 'd1')?.trustTier,
    'external',
    '未签名包按最不信档起算（不假装签过名）',
  );
  assert.strictEqual(ledger!.list().filter((e) => e.action === 'pack-install').length, 1);
});

test('D2 正常路径（签名包）：入册 + 逐资产入账 + 链验签绿 + 元数据只出公开字段', async () => {
  const { installer, registry, ledger } = env();
  const { bytes } = manifestOf('good-pack', [skillEntry('g1'), skillEntry('g2')], true);
  const report = await installer.install({ bytes });
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(report.installed, ['g1', 'g2']);
  assert.strictEqual(report.ledgerSeq, 1, '首条入账序号回填报告');
  assert.strictEqual(report.publisher?.runtimeId, 'pub-1');

  const entries = ledger!.list().filter((e) => e.action === 'pack-install');
  assert.strictEqual(entries.length, 2, '逐资产一条 pack-install（Ω-2：任何资产变更 = 链上一条）');
  assert.match(entries[0]?.promoted?.source ?? '', /^pack:good-pack@pub-1\/evolved\/vm$/);
  assert.strictEqual(ledger!.verify().ok, true, '入账不得破坏链完整性');

  // 签名包：档位取「装配下限」（evolved/vm），不是 external。
  assert.strictEqual(registry.recordOf('g1')?.governance.trustTier, 'evolved');
  assert.strictEqual(registry.recordOf('g1')?.lineage.operator, 'twist:a+b', 'lineage 随包带入');
  assert.deepStrictEqual(registry.recordOf('g1')?.lineage.parents, ['a', 'b']);

  const metadata = installer.metadataFor('skill');
  assert.strictEqual(metadata?.kind, 'skill');
  assert.strictEqual(metadata?.assets.length, 2);
  assert.ok(
    !JSON.stringify(metadata).includes('步骤'),
    '元数据只出公开字段：不得带 instructions 明文',
  );
  assert.strictEqual(installer.metadataFor('operator'), undefined, '未注册类型无元数据');
});

test('D2 整包原子：任一资产不过即整包拒（不留部分安装、不留账目）', async () => {
  const invalid = [
    skillEntry('ok-1'),
    { ...skillEntry('bad'), asset: { name: '', description: 'd', instructions: 'i' } },
  ];
  const first = env();
  const badAsset = await first.installer.install({ bytes: manifestOf('p1', invalid, true).bytes });
  assert.strictEqual(badAsset.ok, false);
  assert.match(badAsset.rejectedReason ?? '', /资产校验不通过（bad）/);
  assert.strictEqual(first.registry.recordOf('ok-1'), undefined, '前面通过的资产也不得入册');
  assert.strictEqual(first.ledger!.list().length, 0, '不得留账目');

  const second = env();
  const unknownKind = await second.installer.install({
    bytes: manifestOf('p2', [{ ...skillEntry('x'), schemaKind: 'operator' }], true).bytes,
  });
  assert.strictEqual(unknownKind.ok, false);
  assert.match(unknownKind.rejectedReason ?? '', /资产类型未注册：operator/);

  const third = env();
  const dupInside = await third.installer.install({
    bytes: manifestOf('p3', [skillEntry('same'), skillEntry('same')], true).bytes,
  });
  assert.strictEqual(dupInside.ok, false);
  assert.match(dupInside.rejectedReason ?? '', /包内资产重名：same/);

  const fourth = env();
  fourth.registry.put({
    asset: { name: 'taken', description: 'd', instructions: 'i' },
    schemaKind: 'skill',
    lineage: { parents: [], operator: 'test', bornAt: FIXED_NOW() },
    fitness: undefined,
    governance: {
      trustTier: 'core',
      isolation: 'os-sandbox',
      state: 'active',
      ledgerSeq: undefined,
    },
  });
  const conflict = await fourth.installer.install({
    bytes: manifestOf('p4', [skillEntry('taken')], true).bytes,
  });
  assert.strictEqual(conflict.ok, false);
  assert.match(conflict.rejectedReason ?? '', /资产已存在：taken/);
});

test('D2 档位只收紧：请求更严生效、请求更松整包拒', async () => {
  const stricter = env();
  const tighter = await stricter.installer.install({
    bytes: manifestOf(
      'tight',
      [skillEntry('t1', { trustTier: 'external', isolation: 'os-sandbox' })],
      true,
    ).bytes,
  });
  assert.strictEqual(tighter.ok, true);
  assert.strictEqual(stricter.registry.recordOf('t1')?.governance.trustTier, 'external');
  assert.strictEqual(stricter.registry.recordOf('t1')?.governance.isolation, 'os-sandbox');

  const looser = env();
  const relaxed = await looser.installer.install({
    bytes: manifestOf('loose', [skillEntry('t2', { trustTier: 'core' })], true).bytes,
  });
  assert.strictEqual(relaxed.ok, false);
  assert.match(relaxed.rejectedReason ?? '', /信任档请求放宽（evolved → core）：只可收紧，整包拒/);
  assert.strictEqual(looser.registry.recordOf('t2'), undefined);
  assert.strictEqual(looser.ledger!.list().length, 0);

  const looseIsolation = env();
  const relaxedIso = await looseIsolation.installer.install({
    bytes: manifestOf('loose-iso', [skillEntry('t3', { isolation: 'in-process' })], true).bytes,
  });
  assert.strictEqual(relaxedIso.ok, false);
  assert.match(relaxedIso.rejectedReason ?? '', /隔离档请求放宽（vm → in-process）/);
});

test('D2 无账不生效：没有台账时即使包完全合法也拒装', async () => {
  const { installer, registry } = env(false);
  const report = await installer.install({
    bytes: manifestOf('legal', [skillEntry('n1')], true).bytes,
  });
  assert.strictEqual(report.ok, false);
  assert.match(report.rejectedReason ?? '', /无台账不生效/);
  assert.strictEqual(registry.recordOf('n1'), undefined, '拒装不得留资产');
});

test('D2 容器误读：把插件包/坏字节喂给安装器 ⇒ 如实拒（不抛裸栈）', async () => {
  const { installer, ledger } = env();
  // 插件包：容器同为 zip，但清单是 bundle.json ⇒ 必须按清单名分派并点名缺失项。
  const pluginBundle = Zip.zipStore([{ name: 'bundle.json', data: Buffer.from('{"name":"x"}') }]);
  const wrongContainer = await installer.install({ bytes: pluginBundle });
  assert.strictEqual(wrongContainer.ok, false);
  assert.match(wrongContainer.rejectedReason ?? '', /不是资产包：缺少 asset-pack\.json/);
  assert.match(wrongContainer.rejectedReason ?? '', /包内条目：bundle\.json/, '报错要点名包内条目');

  const garbage = await installer.install({ bytes: Buffer.from('not-a-zip') });
  assert.strictEqual(garbage.ok, false);
  assert.ok((garbage.rejectedReason ?? '').length > 0, '拒装必须给可读原因');
  assert.strictEqual(ledger!.list().length, 0, '误读包不得留下账目');
});

// ---- Wave C2：档位门禁 + 冒烟（§4 F3 第四步）----

/**
 * 建一套「带隔离阶梯」的安装环境。
 * @param opts 档位下限与阶梯注入
 * @returns 环境
 */
function isolatedEnv(opts: {
  readonly defaultIsolation: IsolationLevel;
  readonly ladder?: IsolationPort;
}): {
  readonly installer: AssetPackInstaller;
  readonly registry: CapabilityRegistryPort;
  readonly ledger: HashChainPromotionLedger;
} {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  const ledger = new HashChainPromotionLedger({ now: FIXED_NOW });
  const registry = new CapabilityRegistry({ schemas, skills: new SkillRegistry(), ledger });
  const installer = new AssetPackInstaller({
    registry,
    schemas,
    ledger,
    defaults: { trustTier: 'evolved', isolation: opts.defaultIsolation },
    now: FIXED_NOW,
    ...(opts.ladder !== undefined ? { isolation: opts.ladder } : {}),
  });
  return { installer, registry, ledger };
}

test('C2 档位门禁：声明档位不可达（wasm）⇒ 整包拒（不降档），原因点名 wasmtime 未准入', async () => {
  const { installer, registry, ledger } = isolatedEnv({
    defaultIsolation: 'in-process',
    ladder: new IsolationLadder(),
  });
  const { bytes } = manifestOf('wasm-asset', [skillEntry('w1', { isolation: 'wasm' })], true);
  const report = await installer.install({ bytes });
  assert.strictEqual(report.ok, false);
  assert.match(report.rejectedReason ?? '', /隔离档 wasm 在本机不可达：拒装（不降档；ADR-0010）/);
  assert.strictEqual(registry.recordOf('w1'), undefined, '被拒的包不得留资产');
  assert.strictEqual(ledger.list().length, 0, '被拒的包不得留账目');
});

test('C2 冒烟：in-process 档真跑一次类型度量（经注入的阶梯），失败 ⇒ 整包拒', async () => {
  const seen: string[] = [];
  const spy: IsolationPort = {
    run: async (request) => {
      seen.push(`${request.asset.schemaKind}:${request.level ?? 'default'}`);
      const started = Date.now();
      const result = await new IsolationLadder().run(request);
      void started;
      return result;
    },
    available: () => true,
  };
  const ok = isolatedEnv({ defaultIsolation: 'in-process', ladder: spy });
  const passed = await ok.installer.install({
    bytes: manifestOf('smoke-ok', [skillEntry('s1')], true).bytes,
  });
  assert.strictEqual(passed.ok, true);
  assert.deepStrictEqual(seen, ['skill:in-process'], '冒烟必须真的经阶梯、用资产自己的档位');
  assert.strictEqual(ok.ledger.list().filter((e) => e.action === 'pack-install').length, 1);

  // 度量抛错 ⇒ in-process 档归 trap ⇒ 整包拒（把「装完才发现评估就炸」提前到安装时）。
  const schemas = new CapabilitySchemaRegistry();
  schemas.register({
    kind: 'boom',
    version: 1,
    validate: () => ({ ok: true }),
    evalContract: () => () => {
      throw new Error('度量崩了');
    },
    defaultTrustTier: 'core',
    defaultIsolation: 'in-process',
    ledgerSemantics: { chain: 'promotion', snapshot: 'registry-full' },
  });
  const ledger = new HashChainPromotionLedger({ now: FIXED_NOW });
  const registry = new CapabilityRegistry({ schemas, skills: new SkillRegistry(), ledger });
  const boomInstaller = new AssetPackInstaller({
    registry,
    schemas,
    ledger,
    defaults: { trustTier: 'evolved', isolation: 'in-process' },
    now: FIXED_NOW,
    isolation: new IsolationLadder(),
  });
  const failed = await boomInstaller.install({
    bytes: manifestOf(
      'smoke-bad',
      [{ schemaKind: 'boom', name: 'b1', asset: { name: 'b1' } }],
      true,
    ).bytes,
  });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.rejectedReason ?? '', /冒烟未通过（trap）/);
  assert.match(failed.rejectedReason ?? '', /度量崩了/);
  assert.strictEqual(ledger.list().length, 0, '冒烟失败不得留账目');
});

test('C2 更严档位默认不冒烟（宿主闭包跨 realm 会得到假隔离）：可用即装成功', async () => {
  const { installer, registry, ledger } = isolatedEnv({
    defaultIsolation: 'vm',
    ladder: new IsolationLadder(),
  });
  assert.strictEqual(new IsolationLadder().available('vm'), true);
  const report = await installer.install({
    bytes: manifestOf('vm-asset', [skillEntry('v1')], true).bytes,
  });
  assert.strictEqual(report.ok, true, 'vm 档可用且不适用闭包冒烟 ⇒ 装成功');
  assert.strictEqual(registry.recordOf('v1')?.governance.isolation, 'vm');
  assert.strictEqual(ledger.list().filter((e) => e.action === 'pack-install').length, 1);
});

test('C2 档位原生冒烟载荷：注入 smokePayloadFor ⇒ 更严档位也真冒烟且结果参与门禁', async () => {
  const schemas = new CapabilitySchemaRegistry();
  schemas.register(new SkillSchema());
  const ledger = new HashChainPromotionLedger({ now: FIXED_NOW });
  const registry = new CapabilityRegistry({ schemas, skills: new SkillRegistry(), ledger });
  const ran: string[] = [];
  const installer = new AssetPackInstaller({
    registry,
    schemas,
    ledger,
    defaults: { trustTier: 'evolved', isolation: 'vm' },
    now: FIXED_NOW,
    isolation: new IsolationLadder(),
    smokePayloadFor: (record) => ({
      kind: 'js-source',
      code: '(() => "native-smoke-ok")()',
      filename: `${record.schemaKind}-smoke.js`,
    }),
  });
  const passed = await installer.install({
    bytes: manifestOf('native', [skillEntry('n1')], true).bytes,
  });
  assert.strictEqual(passed.ok, true);
  ran.push('ok');

  // 原生载荷失败 ⇒ 整包拒（vm 档内触达宿主能力 ⇒ escape）。
  const bad = new AssetPackInstaller({
    registry: new CapabilityRegistry({ schemas, skills: new SkillRegistry(), ledger }),
    schemas,
    ledger,
    defaults: { trustTier: 'evolved', isolation: 'vm' },
    now: FIXED_NOW,
    isolation: new IsolationLadder(),
    smokePayloadFor: () => ({
      kind: 'js-source',
      code: '(() => require("node:fs"))()',
      filename: 'escape-smoke.js',
    }),
  });
  const failed = await bad.install({
    bytes: manifestOf('native-bad', [skillEntry('n2')], true).bytes,
  });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.rejectedReason ?? '', /冒烟未通过（escape）/);
  assert.strictEqual(registry.recordOf('n2'), undefined);
});
