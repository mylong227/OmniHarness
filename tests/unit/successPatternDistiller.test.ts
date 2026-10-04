/**
 * E1+（双源信号）判据：成功侧蒸馏器 + 与失败侧的**对称红线**。
 *
 * ## 这份判据要钉死什么
 *
 * ARCHITECTURE/商业化路线图的 E1+ 要求：**双源**（失败→提案 / 成功→工作流模板候选），且
 * 「**变异：掐断任一半边 ⇒ 对应候选恒 0**（红）」。故本文件的核心是**对称红线**：
 *
 * | 输入 | `proposals()`（失败侧） | `workflowTemplateProposals()`（成功侧） |
 * | --- | --- | --- |
 * | 只有失败信号 | > 0 | **≡ 0** |
 * | 只有成功信号 | **≡ 0** | > 0 |
 * | 两者都有 | > 0 | > 0 |
 *
 * 另钉三条纪律：只吃 `production`（seed-bootstrap/synthetic-lab 一律不入）、
 * **不蒸馏工具输出正文**（M3：候选资产只由组合键构造，evidence 只存不解析）、有界（记录与候选都有上限）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SuccessPatternDistiller } from '../../src/evolution/successPatternDistiller.js';
import { SignalIngestor } from '../../src/evolution/signalIngestor.js';
import { WorkflowTemplateSchema } from '../../src/capability/schemas/workflowTemplateSchema.js';
import type { EvolutionSignal } from '../../src/ports/runtime/evolution.js';

/**
 * 造一条成功信号。
 * @param combination 命中的技能组合
 * @param evidence 审计证据
 * @param provenance 数据来源
 * @returns 进化信号
 */
function successSignal(
  combination: readonly string[],
  evidence = 'combo ok',
  provenance: 'production' | 'seed-bootstrap' | 'synthetic-lab' = 'production',
): EvolutionSignal {
  return {
    kind: 'success',
    key: [...combination].sort().join('|'),
    evidence,
    provenance,
    success: { combination },
  };
}

/**
 * 造一条失败信号。
 * @param signature 失败签名
 * @param index 序号（用于唯一化消息）
 * @returns 进化信号
 */
function failureSignal(signature: string, index: number): EvolutionSignal {
  return {
    kind: 'failure',
    key: `telemetry:verify:${signature}`,
    evidence: `失败 #${String(index)}`,
    provenance: 'production',
    failure: { kind: 'verify', location: signature, message: `boom-${String(index)}` },
  };
}

/**
 * 造 n 条同签名失败信号（触发挖掘器的频次阈值）。
 * @param signature 失败签名
 * @param n 条数
 * @returns 信号数组
 */
function failures(signature: string, n: number): readonly EvolutionSignal[] {
  return Array.from({ length: n }, (_, i) => failureSignal(signature, i));
}

/**
 * 造 n 条同组合成功信号。
 * @param combination 组合
 * @param n 条数
 * @returns 信号数组
 */
function successes(combination: readonly string[], n: number): readonly EvolutionSignal[] {
  return Array.from({ length: n }, (_, i) => successSignal(combination, `combo ok #${String(i)}`));
}

test('E1+ 双源红线（对称）：掐断任一半边 ⇒ 对应候选恒 0', () => {
  const combo = ['glob', 'read_file', 'edit'];

  // ① 只有失败信号 ⇒ 有防再犯提案，**工作流模板候选恒 0**。
  const failureOnly = new SignalIngestor({
    distiller: new SuccessPatternDistiller({ frequencyThreshold: 3 }),
  });
  const f1 = failureOnly.ingest(failures('src/core/agent.ts', 3));
  assert.ok(f1.failures >= 3);
  assert.ok(failureOnly.proposals().length > 0, '失败半边必须产出提案');
  assert.deepStrictEqual(
    failureOnly.workflowTemplateProposals(),
    [],
    '掐断成功半边 ⇒ 模板候选恒 0',
  );
  assert.strictEqual(f1.distilled, 0);

  // ② 只有成功信号 ⇒ 有模板候选，**失败侧提案恒 0**。
  const successOnly = new SignalIngestor({
    distiller: new SuccessPatternDistiller({ frequencyThreshold: 3 }),
  });
  const f2 = successOnly.ingest(successes(combo, 3));
  assert.strictEqual(f2.distilled, 3, '三条成功观测都应被蒸馏器接受');
  assert.ok(successOnly.workflowTemplateProposals().length > 0, '成功半边必须产出模板候选');
  assert.deepStrictEqual(successOnly.proposals(), [], '掐断失败半边 ⇒ 防再犯提案恒 0');

  // ③ 两边都有 ⇒ 两边都出（正对照：证明判据不是"永远只出一边"）。
  const both = new SignalIngestor({
    distiller: new SuccessPatternDistiller({ frequencyThreshold: 3 }),
  });
  both.ingest([...failures('src/core/agent.ts', 3), ...successes(combo, 3)]);
  assert.ok(both.proposals().length > 0);
  assert.ok(both.workflowTemplateProposals().length > 0);
});

test('E1+ 候选是**合法**工作流模板：通过 WorkflowTemplateSchema 校验且结构由组合键决定', () => {
  const distiller = new SuccessPatternDistiller({ frequencyThreshold: 2 });
  const combo = ['glob', 'read_file', 'edit'];
  for (const signal of successes(combo, 2)) distiller.observe(signal);
  const proposals = distiller.proposals();
  assert.strictEqual(proposals.length, 1);
  const candidate = proposals[0];
  assert.ok(candidate !== undefined);
  const verdict = new WorkflowTemplateSchema().validate(candidate.asset);
  assert.strictEqual(verdict.ok, true, verdict.ok ? '' : verdict.reason);
  assert.strictEqual(candidate.trustTier, 'signed', '蒸馏产物不得自称 core（需治理面）');
  assert.strictEqual(candidate.frequency, 2);
  // 步骤按组合顺序串联：首步无依赖，后续步依赖前一步产出。
  assert.deepStrictEqual(
    candidate.asset.steps.map((s) => s.action),
    combo,
  );
  assert.deepStrictEqual(candidate.asset.steps[0]?.requires, []);
  assert.deepStrictEqual(candidate.asset.steps[1]?.requires, ['glob']);
  assert.deepStrictEqual(candidate.asset.steps[2]?.requires, ['read_file']);
  // 确定性：同一组合 → 同一模板名（可去重）。
  const again = new SuccessPatternDistiller({ frequencyThreshold: 2 });
  for (const signal of successes([...combo].reverse(), 2)) again.observe(signal);
  assert.strictEqual(again.proposals()[0]?.asset.name, candidate.asset.name);
});

test('E1+ production 门禁：seed-bootstrap / synthetic-lab 的成功信号一律不入候选', () => {
  const combo = ['a', 'b'];
  const distiller = new SuccessPatternDistiller({ frequencyThreshold: 1 });
  assert.strictEqual(distiller.observe(successSignal(combo, 'seed', 'seed-bootstrap')), false);
  assert.strictEqual(distiller.observe(successSignal(combo, 'lab', 'synthetic-lab')), false);
  assert.deepStrictEqual(distiller.proposals(), [], '非 production 数据不得蒸馏成候选');
  // 正对照：production 的同一组合可以入。
  assert.strictEqual(distiller.observe(successSignal(combo, 'prod', 'production')), true);
  assert.strictEqual(distiller.proposals().length, 1);
});

test('E1+ M3 纪律：不蒸馏工具输出正文（evidence 只存不解析）', () => {
  const combo = ['a', 'b'];
  const toolDump = 'TOOL-OUTPUT-SECRET: rm -rf /tmp/x && cat /etc/passwd';
  const distiller = new SuccessPatternDistiller({ frequencyThreshold: 1 });
  distiller.observe(successSignal(combo, toolDump));
  const candidate = distiller.proposals()[0];
  assert.ok(candidate !== undefined);
  const serialized = JSON.stringify(candidate.asset);
  assert.ok(
    !serialized.includes('TOOL-OUTPUT-SECRET'),
    '候选资产正文不得含工具输出内容（只由技能名构造）',
  );
  assert.ok(!serialized.includes('/etc/passwd'), '不得把工具输出里的路径搬进资产');
  // 证据仍然留档（审计可查），但只在 `evidence` 字段里，不进资产。
  assert.ok(candidate.evidence.some((e) => e.includes('TOOL-OUTPUT-SECRET')));
});

test('E1+ 有界：观测记录与候选数都有硬上限，且候选按频次降序', () => {
  const distiller = new SuccessPatternDistiller({
    frequencyThreshold: 1,
    maxRecords: 10,
    maxCandidates: 2,
  });
  // 12 条观测、每个组合各 1 条 ⇒ 记录上限 10 生效（最旧两条被淘汰）。
  for (let i = 0; i < 12; i += 1) distiller.observe(successSignal([`s${String(i)}`, 'x']));
  const proposals = distiller.proposals();
  assert.strictEqual(proposals.length, 2, '候选数上限生效');
  // 频次降序：给一个组合更高频次，它必须排第一。
  const ranked = new SuccessPatternDistiller({ frequencyThreshold: 1, maxCandidates: 5 });
  for (let i = 0; i < 3; i += 1) ranked.observe(successSignal(['hot', 'x']));
  ranked.observe(successSignal(['cold', 'y']));
  const rankedProposals = ranked.proposals();
  assert.strictEqual(rankedProposals[0]?.signature, 'hot|x', '高频组合必须排在前');
  assert.strictEqual(rankedProposals[0]?.frequency, 3);
});
