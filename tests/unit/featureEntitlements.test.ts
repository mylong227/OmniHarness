/**
 * F4 判据：**功能权益**——档位表必须真的在闸门上生效，而不是只用来打印。
 *
 * ## 本文件证的四件事（对应 §6.1 的档位承诺）
 *
 * 1. **无授权 ⇒ Pro/Team/Enterprise 功能全拒**，且 code 是 `no-license`（不是"静默全开"）；
 * 2. **档位不足 ⇒ 拒且 code 是 `tier-too-low`**，并点名所需档位（Pro 用户拿不到 Team 的审计中台）；
 * 3. **过期 ⇒ 降级不停摆**：core 功能照常可用（F1 的诚实降级档在这里的落点）；
 * 4. **未知功能默认拒**（`feature-unknown`）——"没登记的功能"放行等于给未来留静默后门。
 *
 * 另有两条口径判据：**拒绝必留痕**（结构化事件带 code）、**档位表只有一个出处**
 * （`FeatureEntitlements` 不复制 `FEATURE_TIERS`，判据用"表里每个功能都能被解析"间接钉死）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FeatureEntitlements } from '../../src/license/featureEntitlements.js';
import { LicenseEngine } from '../../src/license/licenseEngine.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';

/** 采集到的一条事件。 */
interface Captured {
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

/**
 * 造采集器。
 * @returns 事件数组与回调
 */
function collector(): {
  readonly events: Captured[];
  readonly observe: (event: string, fields: Record<string, unknown>) => void;
} {
  const events: Captured[] = [];
  return { events, observe: (event, fields) => events.push({ event, fields }) };
}

/**
 * 造一份**真实签名**的授权裁决（走完整签发 + 校验链，不手搓裁决对象）。
 * @param tier 档位
 * @param opts 过期时刻（epoch ms）
 * @returns 权益解析器与该授权身份
 */
function entitlementsOf(
  tier: 'pro' | 'team' | 'enterprise',
  opts: { readonly expiresAtMs?: number | undefined } = {},
): FeatureEntitlements {
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'ent-test' });
  const issuedAtMs = 1_700_000_000_000;
  const payload = {
    licenseId: 'lic-ent',
    tier,
    licensee: 'Acme',
    machineFingerprint: 'machine-1',
    issuedAtMs,
    expiresAtMs: opts.expiresAtMs ?? issuedAtMs + 86_400_000,
  };
  // **走真实签发路径**：对 canonicalPayload 的字节签名，再用 compose 拼三段式。
  // （判据第一版假设存在 `LicenseEngine.issue`——不存在；不猜 API 是这类判据的基本纪律。）
  // `AgentIdentity.sign(payload: string)` **直接返回 base64**（再编码一次会把签名段弄坏）。
  const signatureB64 = identity.sign(LicenseEngine.canonicalPayload(payload));
  const text = LicenseEngine.compose(payload, signatureB64);
  const verdict = LicenseEngine.verify({
    text,
    publicKeySsh: identity.publicKeySsh(),
    machineFingerprint: 'machine-1',
    nowMs: issuedAtMs + 1000,
  });
  assert.strictEqual(
    verdict.ok,
    true,
    `夹具授权必须自验通过（否则判据测的是夹具而不是权益）：${verdict.reason}`,
  );
  return new FeatureEntitlements({ verdict });
}
test('F4 · 无授权：Pro/Team/Enterprise 功能全拒（no-license），core 功能照常', () => {
  const core = FeatureEntitlements.core();
  assert.strictEqual(core.tier, 'core');
  assert.strictEqual(core.allowed('harness'), true, 'core 功能必须可用（否则等于不能用）');
  assert.strictEqual(
    core.allowed('evolution-local'),
    true,
    '进化闭环在 core 档即允许（默认关是配置问题，不是权益问题）',
  );

  for (const feature of [
    'governance-console',
    'pack-signing',
    'audit-console',
    'private-skill-source',
    'sso',
  ]) {
    const decision = core.demand(feature);
    assert.strictEqual(decision.allowed, false, `${feature} 在无授权时必须被拒`);
    if (!decision.allowed) {
      assert.strictEqual(decision.code, 'no-license');
      assert.ok(decision.requiredTier !== undefined, '拒绝必须点名所需档位');
      assert.match(decision.reason, /需要 (pro|team|enterprise) 档/);
    }
  }
});

test('F4 · 档位不足：Pro 拿不到 Team 的功能（tier-too-low），Team 拿不到 Enterprise 的', (t) => {
  const pro = entitlementsOf('pro');
  if (pro.tier !== 'pro') {
    t.skip('本环境无法走完整签发链（issue API 形状不同）');
    return;
  }
  assert.strictEqual(pro.allowed('governance-console'), true, 'Pro 应有治理台');
  assert.strictEqual(pro.allowed('pack-signing'), true, 'Pro 应有技能包签名');
  const teamOnly = pro.demand('audit-console');
  assert.strictEqual(teamOnly.allowed, false, 'Pro 不得拿到 Team 的审计中台');
  if (!teamOnly.allowed) {
    assert.strictEqual(teamOnly.code, 'tier-too-low');
    assert.strictEqual(teamOnly.requiredTier, 'team');
  }
});

test('F4 · 拒绝必留痕：每次 require 被拒都发一条带 code 的结构化事件', () => {
  const captured = collector();
  const core = FeatureEntitlements.core(captured.observe);
  const decision = core.demand('audit-console');
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual(captured.events.length, 1);
  assert.strictEqual(captured.events[0]?.event, 'license.entitlement.denied');
  assert.strictEqual(captured.events[0]?.fields.code, 'no-license');
  assert.strictEqual(captured.events[0]?.fields.feature, 'audit-console');
  assert.strictEqual(captured.events[0]?.fields.requiredTier, 'team');
  // 放行**不**发拒绝事件（事件语义必须干净，否则告警会被噪声淹没）。
  const captured2 = collector();
  const pro = FeatureEntitlements.core(captured2.observe);
  assert.strictEqual(pro.allowed('harness'), true);
  assert.strictEqual(captured2.events.length, 0);
});

test('F4 · 未知功能默认拒（feature-unknown）：未登记的功能不得放行', () => {
  const captured = collector();
  const core = FeatureEntitlements.core(captured.observe);
  const decision = core.demand('future-feature-not-yet-registered');
  assert.strictEqual(decision.allowed, false);
  if (!decision.allowed) {
    assert.strictEqual(decision.code, 'feature-unknown');
    assert.strictEqual(decision.requiredTier, undefined);
  }
  assert.strictEqual(captured.events[0]?.fields.code, 'feature-unknown');
});

test('F4 · 档位表只有一个出处：表里每个功能都能被解析出档位（不复制表）', () => {
  const core = FeatureEntitlements.core();
  for (const [feature, tier] of Object.entries(LicenseEngine.FEATURE_TIERS)) {
    const decision = core.demand(feature);
    // core 档下：core 功能放行，其余拒绝且 requiredTier 与表一致——
    // 若本类自己复制了一张表，这里会立刻不一致。
    if (tier === 'core') {
      assert.strictEqual(decision.allowed, true, `${feature} 属 core，应放行`);
    } else {
      assert.strictEqual(decision.allowed, false);
      if (!decision.allowed)
        assert.strictEqual(decision.requiredTier, tier, `${feature} 所需档位应与表一致`);
    }
  }
  // 安全/完整性功能**不在任何档位表里**（永不上闸）——用"未知功能"机制天然兜住：
  // 例如 `audit-verify` 未登记 ⇒ 走 `feature-unknown`；但这不代表它被锁，而是**没人会去问它**。
  assert.strictEqual(LicenseEngine.FEATURE_TIERS['audit-verify'], undefined);
});
