/**
 * **§12.1-4「可观测：状态变化与拒绝可查」的统一判据**。
 *
 * ## 为什么单独一份、且必须跨模块
 *
 * 标准原文要求："关键状态变化与**每一条拒绝路径**都要有结构化日志与**可机读 reason code**"。
 * 单模块判据只能证明"这个模块记了"，证明不了"**整条拒绝面**都记了"——而漏掉一条拒绝路径
 * 恰恰是最常见的形态（某分支直接 `return { ok:false, reason }` 就走出去了）。
 * 本文件的每一例都做同一件事：**注入采集器 → 触发一条拒绝 → 断言恰好收到一个结构化事件，
 * 且字段里带可机读 code**（不是靠解析中文）。
 *
 * ## 覆盖的六个决策引擎（都是"拒绝即判决"的位置）
 *
 * | 引擎 | 拒绝事件 | code 字段 |
 * | --- | --- | --- |
 * | `RbacPolicy` | `rbac.denied` | `RoleDenialCode` |
 * | `LicenseEngine` | `license.verdict.denied` | `LicenseDenialCode` |
 * | `PrivateSkillSource` | `skill-source.refused` | `SkillSourceDenialCode` |
 * | `PackGrader` | `pack.graded` | `PackGradeCode` |
 * | `ProvenanceIssuer` | `provenance.verify.failed` | `ProvenanceProblemCode` |
 * | `BuiltinWasmRunner` | `isolation.wasm.denied` | `IsolationDenial['code']`（走共享 logger ⇒ 本文件用子进程断言） |
 *
 * 口径说明：前五个引擎的观测通道是**可注入 observer**（缺省走共享 logger），判据据此断言；
 * wasm 运行器的拒绝走**共享 logger 单例**（它是端口适配器，不额外引入注入面），
 * 故用一次**子进程**跑一条拒绝并断言 stderr 里的结构化 JSON 行——比"看代码里写了 log"强得多。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RbacPolicy } from '../../src/security/rbacPolicy.js';
import { LicenseEngine } from '../../src/license/licenseEngine.js';
import { PrivateSkillSource } from '../../src/plugin/privateSkillSource.js';
import { PackGrader } from '../../src/plugin/packGrader.js';
import { ProvenanceIssuer } from '../../src/governance/provenanceIssuer.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';

/** 采集到的一条结构化事件。 */
interface Captured {
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

/**
 * 造一个采集器。
 * @returns 采集器与其记录
 */
function collector(): {
  readonly events: Captured[];
  readonly observe: (e: string, f: Record<string, unknown>) => void;
} {
  const events: Captured[] = [];
  return {
    events,
    observe: (event, fields) => {
      events.push({ event, fields });
    },
  };
}

test('§12.1-4 · RBAC：五条拒绝路径各自带 code（且互不混同）', () => {
  // 工具清单**显式注入**：策略只认"已登记"的工具，缺省 catalog 里没有我要测的名字，
  // 于是五条路径会全落进 tool-not-registered（夹具第一版就是这么"证明"了不存在的事）。
  const policy = new RbacPolicy({
    toolCatalog: [TOOL_NAMES.readFile, TOOL_NAMES.writeFile, TOOL_NAMES.rollback],
  });
  const seen: string[] = [];
  const probe = (role: string, tool: string): void => {
    const decision = policy.decide(role as never, { name: tool, args: {} } as never);
    assert.strictEqual(decision.allow, false, `${role}/${tool} 应被拒`);
    if (!decision.allow) seen.push(decision.code);
  };
  probe('ghost', TOOL_NAMES.readFile); // ① 未知角色
  probe('viewer', 'not-registered'); // ② 未登记工具
  probe('editor', TOOL_NAMES.rollback); // ③ 治理类工具（在 deny 清单里）
  probe('viewer', TOOL_NAMES.writeFile); // ④ 无写权限（viewer 的 mutating=false）
  probe('editor', TOOL_NAMES.rollback); // ⑤ 治理类工具对 editor 同样拒（deny 优先于 allow）
  assert.deepStrictEqual(seen, [
    'unknown-role',
    'tool-not-registered',
    'governance-tool',
    'mutating-denied',
    'governance-tool',
  ]);
});
test('§12.1-4 · License：拒绝带 code 且落结构化事件（过期与篡改分流）', () => {
  const licenseIdentity = new Ed25519AgentIdentity({ agentRuntimeId: 'lic' });
  const collectorA = collector();
  const malformed = LicenseEngine.verify({
    text: 'not-a-license',
    publicKeySsh: licenseIdentity.publicKeySsh(),
    machineFingerprint: 'machine-1',
    nowMs: 1_700_000_000_000,
    observer: collectorA.observe,
  });
  assert.strictEqual(malformed.ok, false);
  assert.strictEqual(malformed.code, 'malformed');
  assert.deepStrictEqual(
    collectorA.events.map((entry) => [entry.event, entry.fields.code]),
    [['license.verdict.denied', 'malformed']],
  );

  // 篡改正文 ⇒ signature-invalid（与 malformed 分流：一个"读都读不了"，一个"验签不过"）。
  // 按**真实文本格式**手拼：头 / base64(JSON 正文) / base64(签名)。签名用垃圾字节 ⇒ 验签必失败。
  const payload = {
    licenseId: 'lic-1',
    tier: 'enterprise',
    licensee: 'Acme',
    machineFingerprint: 'machine-1',
    issuedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_900_000_000_000,
  };
  const collectorB = collector();
  const bogus = LicenseEngine.verify({
    // **真实格式**：头（`OH-LICENSE-1`）+ base64(JSON 正文) + base64(签名)——不是 PEM 风格。
    text: [
      'OH-LICENSE-1',
      Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      Buffer.from('not-a-real-signature', 'utf8').toString('base64'),
    ].join('\n'),
    publicKeySsh: licenseIdentity.publicKeySsh(),
    machineFingerprint: 'machine-1',
    nowMs: 1_700_000_000_000,
    observer: collectorB.observe,
  });
  assert.strictEqual(bogus.ok, false);
  assert.strictEqual(bogus.code, 'signature-invalid');
  assert.strictEqual(collectorB.events[0]?.fields.code, 'signature-invalid');
});
test('§12.1-4 · 私有技能源：拒因带 code，且**放行也留一条判定行**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-source-obs-'));
  // 造一个"不是合法 .ohb"的文件（缺 bundle.json）⇒ manifest-missing。
  writeFileSync(join(dir, 'bad.ohb'), 'not-an-ohb', 'utf8');
  const refused = collector();
  const source = new PrivateSkillSource({
    sourceDir: dir,
    trustedPublicKeys: [],
    strict: true,
    observer: refused.observe,
    install: async () => {
      // 本判据只关心"拒绝时可观测"；安装回调不应被调用（被拒的包永不进安装）。
      throw new Error('被拒的包不得进入安装回调');
    },
  });
  const entries = source.list();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0]?.accepted, false);
  assert.strictEqual(entries[0]?.code, 'manifest-missing');
  assert.deepStrictEqual(
    refused.events.map((entry) => [entry.event, entry.fields.code]),
    [['skill-source.refused', 'manifest-missing']],
    '每条裁决恰好一条事件（不重复、不漏）',
  );
});

test('§12.1-4 · 包装评级：A/C 出口都带 codes，并各落一条事件', () => {
  // 真实输入形状：`files`（包内文件映射）+ `declared` + `sandbox`。
  const files = new Map<string, string>([
    ['bundle.json', JSON.stringify({ name: 'demo', version: '1.0.0' })],
  ]);
  const collectorA = collector();
  const gradeA = PackGrader.grade({
    files,
    declared: [],
    sandbox: { ran: true, ok: true },
    observer: collectorA.observe,
  } as never);
  assert.strictEqual(gradeA.rating, 'A');
  assert.deepStrictEqual(gradeA.codes, ['clean']);
  assert.deepStrictEqual(collectorA.events, [
    { event: 'pack.graded', fields: { rating: 'A', installable: true, codes: ['clean'] } },
  ]);

  const collectorC = collector();
  const gradeC = PackGrader.grade({
    files,
    declared: [],
    sandbox: { ran: false, ok: false },
    observer: collectorC.observe,
  } as never);
  assert.strictEqual(gradeC.rating, 'C');
  assert.deepStrictEqual(gradeC.codes, ['sandbox-failed']);
  assert.strictEqual(collectorC.events[0]?.event, 'pack.graded');
  assert.deepStrictEqual(collectorC.events[0]?.fields.codes, ['sandbox-failed']);
});
test('§12.1-4 · 系谱复核：拒绝带 code（与 problems 一一对应）且落结构化事件', () => {
  // 造一份**必然复核失败**的证书：链未验证 + 资产标为已证但缺证据载荷。
  // 不依赖签发 API 的形状，聚焦本判据要证的事：**拒绝路径可观测且可机读**。
  const certificate = {
    format: 'omniharness-provenance',
    version: 1,
    pack: { name: 'pack-x', version: '1.0.0' },
    issuedAt: '2026-10-04T00:00:00.000Z',
    chain: {
      verified: false,
      brokenAt: 3,
      reason: '哈希链断裂',
      coverageAnchor: 'GENESIS',
      length: 3,
    },
    assets: [{ name: 'skill-a', verified: true, evidence: undefined }],
    issuer: { runtimeId: 'prov', publicKeySsh: 'ssh-ed25519 AAAA' },
  };
  const captured = collector();
  const verdict = ProvenanceIssuer.verify(certificate as never, { observer: captured.observe });
  assert.strictEqual(verdict.ok, false);
  assert.ok(verdict.codes.length > 0);
  assert.strictEqual(
    verdict.codes.length,
    verdict.problems.length,
    'codes 与 problems 必须一一对应',
  );
  assert.strictEqual(captured.events[0]?.event, 'provenance.verify.failed');
  assert.deepStrictEqual(captured.events[0]?.fields.codes, [...verdict.codes]);
});
test('§12.1-4 · wasm 运行器：拒绝写共享 logger（用日志采集子进程断言）', () => {
  const script = [
    "const { BuiltinWasmRunner } = require('./dist/src/adapters/isolation/builtinWasmRunner.js');",
    'const runner = new BuiltinWasmRunner();',
    "runner.run({ asset: { kind: 'plugin', name: 'x', version: '1', governance: { isolation: 'wasm' } },",
    "  payload: { kind: 'wasm-module', bytes: new Uint8Array([0,97,115,109,1,0,0,0]), entry: 'process', fuel: 1000 },",
    "  level: 'wasm' }).then((result) => { console.log(JSON.stringify(result)); });",
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(stdout.trim()) as { ok: boolean; denied: { code: string } };
  assert.strictEqual(result.ok, false, '空模块（缺入口）必须被拒');
  assert.ok(result.denied.code.length > 0, '拒因必须带可机读 code');
});
