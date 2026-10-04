/**
 * H3 CLI 判据（`evolution lineage`）：出证与**独立复核**都必须被真实路径消费。
 *
 * ## 判据要钉死什么
 *
 * 1. **出证**：默认对台账里所有已晋升技能出证；`--skill` 可指定子集；`--out` 落盘；
 *    `--sign-key` 用真私钥签名；
 * 2. **独立复核**：`--verify FILE` **不访问台账**（判据用"把台账目录删掉后仍能复核"来证明这一点），
 *    篡改证书 ⇒ 退出码 1 且报出**具体**问题；
 * 3. **不谎报**：未签名证书 / 未给 `--trust` ⇒ 输出明确写"未检查"，绝不写成"已验签"；
 * 4. **用法面**：读不出证书文件 ⇒ 退出码 1（不是静默通过）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvolutionCommand } from '../../src/cli/evolutionCommand.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import type { ProvenanceCertificate } from '../../src/governance/provenanceIssuer.js';
import type { Skill } from '../../src/ports/skill/skill.js';

/**
 * 采集 stdout/stderr 并跑命令。
 * @param run 被测动作
 * @returns 两条流文本与退出码
 */
async function capture(run: () => Promise<number>): Promise<{
  readonly out: string;
  readonly err: string;
  readonly code: number;
}> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    outChunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { out: outChunks.join(''), err: errChunks.join(''), code };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = originalOut;
    (process.stderr as unknown as { write: unknown }).write = originalErr;
  }
}

/**
 * 造一条技能。
 * @param name 技能名
 * @returns 技能
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤` };
}

/**
 * 造一个带真实台账的工作区。
 * @returns 工作区根与台账目录
 */
function workspaceWithLedger(): { readonly root: string; readonly dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'h3cli-'));
  const dir = join(root, '.omniharness', 'evolution');
  const ledger = new HashChainPromotionLedger({ dir, now: () => '2026-10-04T00:00:00.000Z' });
  ledger.snapshotBefore([skillOf('a')]);
  ledger.append({ name: 'c', source: 'twist:a+b' });
  ledger.append({ name: 'd', source: 'pack:demo@pub-1' });
  return { root, dir };
}

test('H3 CLI 出证：默认覆盖台账里全部已晋升技能，文本与 --json 两种形态都可用', async () => {
  const { root } = workspaceWithLedger();
  const command = new EvolutionCommand();
  const text = await capture(() => command.run(['lineage', '--workspace', root]));
  assert.strictEqual(text.code, 0, text.err);
  assert.match(text.out, /进化系谱证书：local-workspace（2 项资产，链可信）/);
  assert.match(text.out, /✓ c（ledger-promotion） ← twist:a\+b/);
  assert.match(text.out, /✓ d（ledger-promotion） ← pack:demo@pub-1/);
  assert.match(text.out, /seq=2 promote c/);
  assert.match(text.out, /前置快照 seq=1/);
  assert.match(text.out, /签名：未签名（哈希链部分仍可独立复核）/);

  const asJson = await capture(() => command.run(['lineage', '--workspace', root, '--json']));
  assert.strictEqual(asJson.code, 0);
  const certificate = JSON.parse(asJson.out) as ProvenanceCertificate;
  assert.strictEqual(certificate.version, 1);
  assert.deepStrictEqual(
    certificate.assets.map((asset) => asset.name),
    ['c', 'd'],
  );
  assert.strictEqual(certificate.chain.verified, true);
  assert.ok(certificate.chain.coverageAnchor.length === 64, '必须带证据起点锚点');
});

test('H3 CLI：--skill 指定子集 / 未证技能如实标 unproven / --out 落盘 / --sign-key 真签名', async () => {
  const { root } = workspaceWithLedger();
  const command = new EvolutionCommand();
  const out = join(root, 'cert.json');
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'cli-issuer' });
  const keyFile = join(root, 'issuer.key');
  writeFileSync(keyFile, identity.privateKeyPkcs8Base64(), 'utf8');

  const issued = await capture(() =>
    command.run([
      'lineage',
      '--workspace',
      root,
      '--skill',
      'c',
      '--skill',
      'not-from-ledger',
      '--pack',
      'demo-pack',
      '--out',
      out,
      '--sign-key',
      keyFile,
    ]),
  );
  assert.strictEqual(issued.code, 0, issued.err);
  assert.match(issued.out, /demo-pack（2 项资产/);
  assert.match(issued.out, /\? not-from-ledger（unproven）/);
  assert.match(issued.out, /本证书不为它作证/);
  assert.match(issued.out, /签名：已签名/);
  assert.match(issued.out, /已写入/);

  const certificate = JSON.parse(readFileSync(out, 'utf8')) as ProvenanceCertificate;
  assert.ok(certificate.issuer !== undefined);
  assert.strictEqual(certificate.issuer.publicKeySsh, identity.publicKeySsh());

  // 独立复核：信任根内 ⇒ 合格；冒充的信任根 ⇒ 不合格。
  const okVerify = await capture(() =>
    command.run(['lineage', '--verify', out, '--trust', identity.publicKeySsh()]),
  );
  assert.strictEqual(okVerify.code, 0, okVerify.out + okVerify.err);
  assert.match(okVerify.out, /合格/);
  assert.match(okVerify.out, /签名：已验签/);
  assert.match(okVerify.out, /\? not-from-ledger（unproven，重算未通过）/, 'unproven 必须如实呈现');

  const stranger = new Ed25519AgentIdentity({ agentRuntimeId: 'stranger' });
  const badTrust = await capture(() =>
    command.run(['lineage', '--verify', out, '--trust', stranger.publicKeySsh()]),
  );
  assert.strictEqual(badTrust.code, 1);
  assert.match(badTrust.out, /不合格/);
  assert.match(badTrust.out, /不在信任根内/);
});

test('H3 CLI 独立复核：**不访问台账**（删掉台账目录后仍能复核），篡改证书即拒', async () => {
  const { root, dir } = workspaceWithLedger();
  const command = new EvolutionCommand();
  const out = join(root, 'cert.json');
  const issue = await capture(() =>
    command.run(['lineage', '--workspace', root, '--out', out, '--json']),
  );
  assert.strictEqual(issue.code, 0, issue.err);

  // **核心证明**：把台账整个删掉，复核仍然可行（证书自带可重算载荷）。
  rmSync(dir, { recursive: true, force: true });
  const stillOk = await capture(() => command.run(['lineage', '--verify', out]));
  assert.strictEqual(stillOk.code, 0, stillOk.out + stillOk.err);
  assert.match(stillOk.out, /合格/);
  assert.match(stillOk.out, /未检查（未给 --trust）/, '未给信任根必须如实说"未检查"');

  // 篡改证据哈希 ⇒ 复核不合格且报具体问题。
  const certificate = JSON.parse(readFileSync(out, 'utf8')) as ProvenanceCertificate;
  const tampered = structuredClone(certificate) as ProvenanceCertificate;
  const first = tampered.assets[0];
  assert.ok(first?.evidence !== undefined);
  // `readonly` 只约束正常路径；篡改判据需要写入 ⇒ 先转可变视图（同 H3 库层判据的做法）。
  const mutableAssets = tampered.assets as unknown as {
    [index: number]: ProvenanceCertificate['assets'][number];
  };
  mutableAssets[0] = {
    ...first,
    evidence: { entry: first.evidence.entry, hash: 'e'.repeat(64) },
  };
  const tamperedPath = join(root, 'tampered.json');
  writeFileSync(tamperedPath, JSON.stringify(tampered), 'utf8');
  const detected = await capture(() => command.run(['lineage', '--verify', tamperedPath]));
  assert.strictEqual(detected.code, 1);
  assert.match(detected.out, /证据哈希对不上/);

  // 读不出的证书文件 ⇒ 退出码 1（不是静默通过）。
  const missing = await capture(() =>
    command.run(['lineage', '--verify', join(root, 'nope.json')]),
  );
  assert.strictEqual(missing.code, 1);
  assert.match(missing.err, /无法读取证书/);
});
