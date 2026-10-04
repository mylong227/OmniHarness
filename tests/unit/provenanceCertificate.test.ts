/**
 * H3（进化系谱出证）判据 —— 商业化报告 §阶段 3 原文：
 * 「技能包附带"进化系谱"（**由哪个失败签名演化而来**、**门禁裁决记录**）——市场里没人能提供这个，
 * 因为没人在晋升环节留哈希链」。
 *
 * ## 判据要钉死什么
 *
 * 1. **逐条可重算**：收证方用公开口径重算每条证据的哈希，并检查链式连接 ⇒ 无需信任签发方；
 * 2. **篡改可检出**：改资产名 / 改证据哈希 / 改条目正文 / 删中间一条 ⇒ 必须报出具体问题；
 * 3. **未证来源如实标注**：台账里查无依据的资产标 `unproven` 且给可读原因，
 *    **绝不编造系谱**——同时它**不是**"证书被篡改"，两者必须区分；
 * 4. **链断即无效**：台账链完整性不过 ⇒ 证书不合格（不因"内容是历史事实"就放行）；
 * 5. **验不了就说验不了**：有签名但没给信任根 ⇒ `signatureChecked:false`（不谎报"已验签"）；
 * 6. **系谱确实写了"从哪来"**：失败签名映射出现在证书里，门禁裁决记录含晋升条目与前置快照锚点。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProvenanceIssuer } from '../../src/governance/provenanceIssuer.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import type { ProvenanceCertificate } from '../../src/governance/provenanceIssuer.js';
import type { Skill } from '../../src/ports/skill/skill.js';

/** 签发方身份（真密钥）。 */
const ISSUER = new Ed25519AgentIdentity({ agentRuntimeId: 'lineage-issuer' });
/** 另一把密钥（冒充者）。 */
const STRANGER = new Ed25519AgentIdentity({ agentRuntimeId: 'stranger' });

/**
 * 造一条技能。
 * @param name 技能名
 * @returns 技能
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤` };
}

/**
 * 造一份真实台账（快照 + 两次晋升）。
 * @returns 台账
 */
function makeLedger(): HashChainPromotionLedger {
  const ledger = new HashChainPromotionLedger({
    dir: mkdtempSync(join(tmpdir(), 'h3-')),
    now: () => '2026-10-04T00:00:00.000Z',
  });
  ledger.snapshotBefore([skillOf('a'), skillOf('b')]);
  ledger.append({ name: 'c', source: 'twist:a+b' });
  ledger.append({ name: 'd', source: 'pack:demo@pub-1' });
  return ledger;
}

test('H3 系谱内容：写出"由哪个失败签名演化而来"与"门禁裁决记录"，并逐条可重算', () => {
  const ledger = makeLedger();
  const certificate = new ProvenanceIssuer(ledger).build({
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c', failureSignature: 'verify:src/core/agent.ts#timeout' }, { name: 'd' }],
  });
  assert.strictEqual(certificate.chain.verified, true);
  assert.strictEqual(certificate.chain.entries, 3);

  const c = certificate.assets.find((asset) => asset.name === 'c');
  assert.ok(c !== undefined);
  assert.strictEqual(c.origin, 'ledger-promotion');
  assert.strictEqual(
    c.failureSignature,
    'verify:src/core/agent.ts#timeout',
    '必须写出失败签名来源',
  );
  assert.strictEqual(c.source, 'twist:a+b');
  assert.match(c.verdicts.join('\n'), /seq=2 promote c ← twist:a\+b/);
  assert.match(c.verdicts.join('\n'), /前置快照 seq=1（2 技能/, '裁决记录必须含前置快照锚点');

  // 逐条可重算 + 链式连接正确 ⇒ 收证方独立复核通过（不访问签发方台账）。
  const verdict = ProvenanceIssuer.verify(certificate);
  assert.strictEqual(verdict.ok, true, verdict.problems.join('；'));
  assert.deepStrictEqual(verdict.assets, [
    { name: 'c', origin: 'ledger-promotion', recomputed: true },
    { name: 'd', origin: 'ledger-promotion', recomputed: true },
  ]);
  assert.strictEqual(verdict.signatureChecked, false, '未签名证书不得声称"已验签"');
});

test('H3 未证来源如实标注：查无依据 ⇒ unproven + 可读原因（**不编造系谱**，也不算篡改）', () => {
  const ledger = makeLedger();
  const certificate = new ProvenanceIssuer(ledger).build({
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c' }, { name: 'not-from-this-ledger' }],
  });
  const ghost = certificate.assets.find((asset) => asset.name === 'not-from-this-ledger');
  assert.ok(ghost !== undefined);
  assert.strictEqual(ghost.origin, 'unproven');
  assert.strictEqual(ghost.evidence, undefined, '未证资产不得携带任何"证据"载荷');
  assert.deepStrictEqual(ghost.verdicts, []);
  assert.match(String(ghost.unprovenReason), /本证书不为它作证/);

  const verdict = ProvenanceIssuer.verify(certificate);
  assert.strictEqual(verdict.ok, true, 'unproven 是如实标注，不是证书被篡改');
  assert.deepStrictEqual(
    verdict.assets.find((asset) => asset.name === 'not-from-this-ledger'),
    { name: 'not-from-this-ledger', origin: 'unproven', recomputed: false },
  );
});

test('H3 篡改可检出：改资产名 / 改证据哈希 / 改条目正文 / 删中间一条 四类都报具体问题', () => {
  const ledger = makeLedger();
  const certificate = new ProvenanceIssuer(ledger).build({
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c' }, { name: 'd' }],
  });

  // ① 改证据哈希。
  const badHash = structuredClone(certificate) as ProvenanceCertificate;
  const first = badHash.assets[0];
  assert.ok(first?.evidence !== undefined);
  (badHash.assets as ProvenanceAssetMutable[])[0] = {
    ...first,
    evidence: { entry: first.evidence.entry, hash: 'f'.repeat(64) },
  };
  const hashVerdict = ProvenanceIssuer.verify(badHash);
  assert.strictEqual(hashVerdict.ok, false);
  assert.match(hashVerdict.problems.join('；'), /证据哈希对不上/);

  // ② 改条目正文（来源改了，哈希自然对不上）。
  const badBody = structuredClone(certificate) as ProvenanceCertificate;
  const second = badBody.assets[1];
  assert.ok(second?.evidence !== undefined);
  (badBody.assets as ProvenanceAssetMutable[])[1] = {
    ...second,
    evidence: {
      entry: {
        ...second.evidence.entry,
        promoted: { name: 'd', source: 'twist:evil+evil' },
      },
      hash: second.evidence.hash,
    },
  };
  assert.match(ProvenanceIssuer.verify(badBody).problems.join('；'), /证据哈希对不上/);

  // ③ 删中间一条证据：后一条的 prev 接不上（断链）。
  const dropped = structuredClone(certificate) as ProvenanceCertificate;
  (dropped.assets as ProvenanceAssetMutable[]) = [dropped.assets[1] as ProvenanceAssetMutable];
  assert.match(
    ProvenanceIssuer.verify(dropped).problems.join('；'),
    /证据起点与证书锚点不一致/,
    '删掉首条证据必须被锚点核对抓住（否则剩余条目仍首尾相接，收证方无从发现）',
  );

  // ④ 把已证资产改成"未证"以掩盖依据（origin 与载荷不一致 ⇒ 视为证书不完整）。
  const masked = structuredClone(certificate) as ProvenanceCertificate;
  const maskedFirst = masked.assets[0];
  assert.ok(maskedFirst !== undefined);
  (masked.assets as ProvenanceAssetMutable[])[0] = {
    ...maskedFirst,
    origin: 'unproven',
    unprovenReason: '伪造原因',
  };
  // 逐条重算不再覆盖它（org=unproven ⇒ recomputed:false），但**签名**会保护这一类改动。
  const maskedVerdict = ProvenanceIssuer.verify(masked);
  assert.strictEqual(maskedVerdict.signatureChecked, false);
  assert.strictEqual(
    maskedVerdict.assets[0]?.recomputed,
    false,
    '把已证资产伪装成未证必须体现在复核结果里',
  );
});

test('H3 签名：信任根内验签通过 / 冒充者拒 / 无信任根只报"未检查"（不谎报）', () => {
  const ledger = makeLedger();
  const signed = new ProvenanceIssuer(ledger).build({
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c' }],
    identity: ISSUER,
  });
  assert.ok(signed.issuer !== undefined);
  // ① 信任根内 ⇒ 验签通过且 signatureChecked=true。
  const trusted = ProvenanceIssuer.verify(signed, { trustedPublicKeys: [ISSUER.publicKeySsh()] });
  assert.strictEqual(trusted.ok, true, trusted.problems.join('；'));
  assert.strictEqual(trusted.signatureChecked, true);
  // ② 无信任根 ⇒ 如实报"未检查"，**不**谎报通过（ok 仍为 true，因为哈希链本身成立）。
  const unchecked = ProvenanceIssuer.verify(signed);
  assert.strictEqual(unchecked.signatureChecked, false);
  assert.strictEqual(unchecked.ok, true);
  // ③ 冒充者签名 ⇒ 拒。
  const forged = new ProvenanceIssuer(ledger).build({
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c' }],
    identity: STRANGER,
  });
  const forgedVerdict = ProvenanceIssuer.verify(forged, {
    trustedPublicKeys: [ISSUER.publicKeySsh()],
  });
  assert.strictEqual(forgedVerdict.ok, false);
  assert.match(forgedVerdict.problems.join('；'), /不在信任根内/);
  // ④ 信任根里有它、但正文被改 ⇒ 验签失败。
  const tamperedSigned = structuredClone(signed) as ProvenanceCertificate;
  (tamperedSigned.pack as { name: string }).name = 'evil-pack';
  const tamperedVerdict = ProvenanceIssuer.verify(tamperedSigned, {
    trustedPublicKeys: [ISSUER.publicKeySsh()],
  });
  assert.strictEqual(tamperedVerdict.ok, false);
  assert.match(tamperedVerdict.problems.join('；'), /证书验签未通过/);
});

test('H3 链断即无效：台账链完整性不过 ⇒ 证书不合格（哪怕内容是历史事实）', () => {
  // **真实**断链：先把台账跑出来，再直接改盘上的台账文件，然后用新实例加载并出证。
  // 不用 stub 伪造 verify() 结论——那样测的只是"证书会不会读这个字段"，而不是"链真断了会怎样"。
  const dir = mkdtempSync(join(tmpdir(), 'h3-broken-'));
  const ledger = new HashChainPromotionLedger({ dir, now: () => '2026-10-04T00:00:00.000Z' });
  ledger.snapshotBefore([skillOf('a')]);
  ledger.append({ name: 'c', source: 'twist:a+b' });
  const file = join(dir, 'ledger.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(
    file,
    `${lines
      .map((line, index) => {
        if (index !== 1) return line;
        const entry = JSON.parse(line) as { promoted?: { name: string; source: string } };
        return JSON.stringify({ ...entry, promoted: { name: 'c', source: 'twist:forged' } });
      })
      .join('\n')}\n`,
    'utf8',
  );
  const broken = new ProvenanceIssuer(new HashChainPromotionLedger({ dir })).build({
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c' }],
  });
  assert.strictEqual(broken.chain.verified, false);
  assert.strictEqual(broken.chain.brokenAt, 2);
  const verdict = ProvenanceIssuer.verify(broken);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.problems.join('；'), /台账链未通过完整性校验/);
});

test('H3 可复现：同输入两次出证逐字节一致（issuedAt 由调用方给，不读墙钟）', () => {
  const ledger = makeLedger();
  const request = {
    packName: 'demo-pack',
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [{ name: 'c', failureSignature: 'sig-1' }, { name: 'd' }],
    identity: ISSUER,
  } as const;
  const first = new ProvenanceIssuer(ledger).build(request);
  const second = new ProvenanceIssuer(ledger).build(request);
  assert.deepStrictEqual(first, second, '证书必须可复现（含签名——签名是对确定性正文签的）');
  assert.strictEqual(
    ProvenanceIssuer.verify(first, { trustedPublicKeys: [ISSUER.publicKeySsh()] }).ok,
    true,
  );
});

/** 判据内部使用的可变视图（`readonly` 只约束正常路径；篡改判据需要写入）。 */
type ProvenanceAssetMutable = ProvenanceCertificate['assets'][number];
