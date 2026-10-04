/**
 * F1（License 引擎）判据 —— 商业化报告 §5 阶段 1 的两条硬判据 + fail-closed 面。
 *
 * ## 判据逐条对应
 *
 * | # | 判据 | 本文件怎么判 |
 * | --- | --- | --- |
 * | ① | **篡改 license ⇒ 拒** | 改档位 / 改机器指纹 / 改到期时刻（正文动了签名就不匹配）/ 换签名 —— 四类各一例，全部回 `core` 且原因可读 |
 * | ② | **过期 ⇒ 降级为核心功能而非停摆** | 过期 license：`tier==='core'`、`expired===true`、**不抛错**；且 `featureAllowed` 对 `harness`（核心）**仍为 true**、对 `governance-console`（Pro）为 false |
 * | ③ | fail-closed | 空文本 / 垃圾文本 / 头不对 / 跨机器 / 未来签发 ⇒ `core` + 可读原因，**不抛** |
 * | ④ | 档位-功能表 | `featureAllowed` 逐档断言；**未登记功能名一律 false**（新功能必须先登记档位） |
 *
 * 夹具用**真的 Ed25519 密钥对**签发（不 mock 验签）——否则"篡改被拒"可能只是因为验签根本没跑。
 * 判据自带正对照：合法 license 必须 `ok:true`（防"全拒"骗过安全判据）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LicenseEngine } from '../../src/license/licenseEngine.js';
import type { LicensePayload } from '../../src/license/licenseEngine.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';

/** 固定"当前时刻"（判据确定性；不读墙钟）。 */
const NOW = Date.parse('2026-10-04T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * 造一份被真实签名的 license。
 * @param identity 授权方身份（持私钥，签）
 * @param overrides 正文覆盖
 * @returns license 文本与正文
 */
function issue(
  identity: Ed25519AgentIdentity,
  overrides: Partial<LicensePayload> = {},
): { readonly text: string; readonly payload: LicensePayload } {
  const payload: LicensePayload = {
    licenseId: 'lic-001',
    tier: 'pro',
    machineFingerprint: LicenseEngine.machineFingerprint(),
    issuedAtMs: NOW - DAY,
    expiresAtMs: NOW + 30 * DAY,
    ...overrides,
  };
  return {
    text: LicenseEngine.compose(payload, identity.sign(LicenseEngine.canonicalPayload(payload))),
    payload,
  };
}

/**
 * 校验一份 license 文本（注入固定时刻）。
 * @param text license 文本
 * @param publicKeySsh 授权方公钥
 * @returns 结论
 */
function verify(text: string, publicKeySsh: string): ReturnType<typeof LicenseEngine.verify> {
  return LicenseEngine.verify({
    text,
    publicKeySsh,
    nowMs: NOW,
    machineFingerprint: LicenseEngine.machineFingerprint(),
  });
}

test('F1 正对照：合法 license ⇒ 采信对应档位（防"全拒"骗过安全判据）', () => {
  const licensor = new Ed25519AgentIdentity({ agentRuntimeId: 'licensor' });
  const { text } = issue(licensor, { tier: 'team' });
  const verdict = verify(text, licensor.publicKeySsh());
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.strictEqual(verdict.tier, 'team');
  assert.strictEqual(verdict.expired, false);
  assert.strictEqual(verdict.payload?.licenseId, 'lic-001');
  // 另一把私钥签的同一正文必须被拒（证明验签用的是授权方公钥，不是"任何签名都收"）。
  const impostor = new Ed25519AgentIdentity({ agentRuntimeId: 'impostor' });
  const forged = { ...verdict.payload };
  const forgedText = LicenseEngine.compose(
    forged,
    impostor.sign(LicenseEngine.canonicalPayload(forged)),
  );
  assert.strictEqual(verify(forgedText, licensor.publicKeySsh()).ok, false, '冒充者签名必须被拒');
});

test('F1 判据①：篡改四类（档位/机器/到期/签名）一律拒，且原因可读', () => {
  const licensor = new Ed25519AgentIdentity({ agentRuntimeId: 'licensor' });
  const pub = licensor.publicKeySsh();
  const { text, payload } = issue(licensor);

  // ①-a 改档位（pro → enterprise）：正文变了 ⇒ 签名不匹配。
  const tamperedTier = LicenseEngine.compose(
    { ...payload, tier: 'enterprise' },
    payloadToSignature(text),
  );
  const tierVerdict = verify(tamperedTier, pub);
  assert.strictEqual(tierVerdict.ok, false);
  assert.match(tierVerdict.reason, /验签未通过|篡改/);
  assert.strictEqual(tierVerdict.tier, 'core');

  // ①-b 改机器指纹。
  const tamperedMachine = LicenseEngine.compose(
    { ...payload, machineFingerprint: 'deadbeefdeadbeef' },
    payloadToSignature(text),
  );
  assert.strictEqual(verify(tamperedMachine, pub).ok, false);

  // ①-c 改到期时刻（把试用期拉长）。
  const extended = LicenseEngine.compose(
    { ...payload, expiresAtMs: NOW + 3650 * DAY },
    payloadToSignature(text),
  );
  assert.strictEqual(verify(extended, pub).ok, false);

  // ①-d 换签名（把签名换掉，正文不动）。
  const swapped = LicenseEngine.compose(payload, Buffer.from('not-a-signature').toString('base64'));
  const swappedVerdict = verify(swapped, pub);
  assert.strictEqual(swappedVerdict.ok, false);
  assert.strictEqual(swappedVerdict.tier, 'core');
});

test('F1 判据②：过期 ⇒ **降级为核心功能而非停摆**（核心照常、Pro 被拒、不抛错）', () => {
  const licensor = new Ed25519AgentIdentity({ agentRuntimeId: 'licensor' });
  // 夹具注意：`issuedAtMs` 必须**早于** `expiresAtMs`——两者相等会被解析层判为**格式非法**
  // （那不是"过期"。第一版夹具就踩了这个坑：`expired` 恒 false，看起来像实现没标记）。
  const { text } = issue(licensor, {
    tier: 'pro',
    issuedAtMs: NOW - 30 * DAY,
    expiresAtMs: NOW - DAY,
  });
  let verdict: ReturnType<typeof LicenseEngine.verify>;
  assert.doesNotThrow(() => {
    verdict = verify(text, licensor.publicKeySsh());
  });
  assert.strictEqual(verdict!.ok, false, '过期不得算有效授权');
  assert.strictEqual(verdict!.tier, 'core', '过期必须退回核心档');
  assert.strictEqual(verdict!.expired, true, '必须如实标记"因过期降级"（调用方据此提示续期）');
  assert.match(verdict!.reason, /已过期/);

  // 降级不是停摆：核心功能仍允许，Pro 功能被拒。
  assert.strictEqual(
    LicenseEngine.featureAllowed(verdict!.tier, 'harness'),
    true,
    '核心功能必须照常可用',
  );
  assert.strictEqual(LicenseEngine.featureAllowed(verdict!.tier, 'evolution-local'), true);
  assert.strictEqual(
    LicenseEngine.featureAllowed(verdict!.tier, 'governance-console'),
    false,
    'Pro 功能必须被拒（否则"过期"没有约束力）',
  );
});

test('F1 判据③：fail-closed —— 空/垃圾/头不对/跨机器/未来签发一律回核心档且不抛', () => {
  const licensor = new Ed25519AgentIdentity({ agentRuntimeId: 'licensor' });
  const pub = licensor.publicKeySsh();
  const { text, payload } = issue(licensor);

  const cases: readonly {
    readonly name: string;
    readonly input: string;
    readonly pattern: RegExp;
  }[] = [
    { name: '空文本', input: '', pattern: /格式非法|头非法/ },
    { name: '垃圾文本', input: 'hello world\nnot a license', pattern: /格式非法|头非法|JSON/ },
    { name: '头不对', input: text.replace('OH-LICENSE-1', 'OH-TRIAL-9'), pattern: /头非法/ },
    {
      name: '正文非 base64-JSON',
      input: `OH-LICENSE-1\n${Buffer.from('not json', 'utf8').toString('base64')}\nsig\n`,
      pattern: /JSON/,
    },
  ];
  for (const item of cases) {
    let verdict: ReturnType<typeof LicenseEngine.verify> | undefined;
    assert.doesNotThrow(() => {
      verdict = verify(item.input, pub);
    }, `${item.name} 不得抛错（fail-closed 不是抛异常）`);
    assert.strictEqual(verdict!.ok, false, `${item.name} 必须被拒`);
    assert.strictEqual(verdict!.tier, 'core');
    assert.match(verdict!.reason, item.pattern, `${item.name} 原因应可读`);
  }

  // 跨机器：正文合法且验签通过，但指纹是**别的机器**的 ⇒ 拒。
  const otherMachine = LicenseEngine.compose(
    { ...payload, machineFingerprint: 'ffffffffffffffff' },
    licensor.sign(
      LicenseEngine.canonicalPayload({ ...payload, machineFingerprint: 'ffffffffffffffff' }),
    ),
  );
  const crossVerdict = verify(otherMachine, pub);
  assert.strictEqual(crossVerdict.ok, false);
  assert.match(crossVerdict.reason, /机器指纹不符/);

  // 未来签发（超出容差）⇒ 拒。
  const future = issue(licensor, { issuedAtMs: NOW + 10 * DAY, expiresAtMs: NOW + 40 * DAY });
  const futureVerdict = verify(future.text, pub);
  assert.strictEqual(futureVerdict.ok, false);
  assert.match(futureVerdict.reason, /晚于当前时刻/);
});

test('F1 判据④：档位-功能表逐档生效，未登记功能一律拒（新功能必须先登记）', () => {
  const table: readonly (readonly [string, string, boolean])[] = [
    ['core', 'harness', true],
    ['core', 'governance-console', false],
    ['pro', 'governance-console', true],
    ['pro', 'audit-console', false],
    ['team', 'audit-console', true],
    ['team', 'sso', false],
    ['enterprise', 'sso', true],
    ['enterprise', 'rbac', true],
    ['enterprise', 'compliance-export', true],
  ];
  for (const [tier, feature, allowed] of table) {
    assert.strictEqual(
      LicenseEngine.featureAllowed(tier as 'core', feature as string),
      allowed,
      `${tier} × ${feature} 应为 ${String(allowed)}`,
    );
  }
  assert.strictEqual(
    LicenseEngine.featureAllowed('enterprise', '未登记的功能'),
    false,
    '未登记功能必须 fail-closed',
  );
});

test('F1 机器指纹：同机恒同值、格式稳定（16 位十六进制），且不依赖环境变量', () => {
  const first = LicenseEngine.machineFingerprint();
  const second = LicenseEngine.machineFingerprint();
  assert.strictEqual(first, second, '同机两次取值必须相同（否则 license 会莫名失效）');
  assert.match(first, /^[0-9a-f]{16}$/, '固定为 16 位十六进制');
  const before = process.env['OMNI_TEST_FINGERPRINT_PROBE'];
  process.env['OMNI_TEST_FINGERPRINT_PROBE'] = 'changed';
  assert.strictEqual(LicenseEngine.machineFingerprint(), first, '不得受环境变量影响');
  if (before === undefined) delete process.env['OMNI_TEST_FINGERPRINT_PROBE'];
  else process.env['OMNI_TEST_FINGERPRINT_PROBE'] = before;
});

/**
 * 取 license 文本里的签名段（用于"改正文、留旧签名"的篡改夹具）。
 * @param text 三段式 license 文本
 * @returns 签名（base64）
 */
function payloadToSignature(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines[2] ?? '';
}
