// 航天级监督内核（I-P0-3 / FDIR）单元测试。
// 覆盖：FDIR 分级降级、危险动作零越权、健康向量入审计哈希链、保守恢复。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisorKernel } from '../../src/supervisor/supervisorKernel.ts';
import { AuditSink } from '../../src/server/services/auditSink.ts';

/** 基础选项：危险工具=写类动作集，连续失败 3 次即 locked。 */
function make(options: ConstructorParameters<typeof SupervisorKernel>[0] = {}) {
  return new SupervisorKernel({
    hazardousTools: ['shell'],
    lockAfterConsecutiveFailures: 3,
    windowSize: 8,
    ...options,
  });
}

test('默认 nominal：非危险工具成功不升级', () => {
  const s = make();
  s.report('read_file', 'success');
  s.report('write_file', 'success');
  assert.strictEqual(s.mode(), 'nominal');
});

test('危险工具单次失败只降 degraded（不拦工具）；累计失败率越线才 safe', () => {
  const s = make({ lockAfterConsecutiveFailures: 100 });
  s.report('shell', 'failure', 'boom');
  assert.strictEqual(s.mode(), 'degraded', '单样本 100% 失败率无统计意义，不得直接 safe');
  assert.strictEqual(s.intercept('shell'), undefined, 'degraded 不拦截任何工具');
  // 攒够 minSamples（默认 4）且失败率仍 100% ⇒ safe，危险工具零越权。
  for (let i = 0; i < 3; i += 1) s.report('shell', 'failure', 'boom');
  assert.strictEqual(s.mode(), 'safe');
  assert.ok(s.intercept('shell')); // safe 下危险工具零越权
});

test('连续失败达 lockAfter → locked，危险工具零越权、非危险放行交门禁', () => {
  const s = make();
  for (let i = 0; i < 3; i += 1) s.report('read_file', 'failure');
  assert.strictEqual(s.mode(), 'locked');
  assert.ok(s.intercept('shell')); // locked 下危险工具拒
  assert.strictEqual(s.intercept('read_file'), undefined); // 非危险放行（交既有门禁裁决）
});

test('普通工具高失败率（≥safeThreshold）→ safe', () => {
  const s = make({ safeThreshold: 0.5, lockAfterConsecutiveFailures: 100, hazardousTools: [] });
  for (let i = 0; i < 4; i += 1) s.report('toolA', 'failure');
  assert.strictEqual(s.mode(), 'safe'); // 4/4 = 1.0 ≥ 0.5
  assert.strictEqual(s.intercept('toolA'), undefined); // 非危险，safe 下不拦
});

test('普通工具中失败率（[degrade,safe)）→ degraded', () => {
  const s = make({
    degradeThreshold: 0.25,
    safeThreshold: 0.5,
    lockAfterConsecutiveFailures: 100,
    hazardousTools: [],
  });
  s.report('toolB', 'failure');
  s.report('toolB', 'success');
  s.report('toolB', 'success');
  s.report('toolB', 'success'); // 1/4 = 0.25 ≥ degrade，< safe
  assert.strictEqual(s.mode(), 'degraded');
});

test('普通工具连续失败（非危险）也能 locked', () => {
  const s = make({ hazardousTools: [] });
  for (let i = 0; i < 3; i += 1) s.report('toolX', 'failure');
  assert.strictEqual(s.mode(), 'locked');
});

test('健康向量入审计哈希链 + 模式转移回调触发', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'omni-sup-')), 'audit.log');
  const audit = new AuditSink({ path });
  const transitions: string[] = [];
  const s = make({ audit, lockAfterConsecutiveFailures: 100 });
  s.onTransition((from, to) => transitions.push(`${from}->${to}`));
  s.report('shell', 'failure'); // 单次失败 → degraded（样本不足不做失败率判定）
  s.report('shell', 'failure');
  s.report('shell', 'failure');
  s.report('shell', 'failure'); // 4/4 = 1.0 ⇒ safe
  assert.strictEqual(s.mode(), 'safe');
  assert.ok(transitions.includes('degraded->safe'), '单次失败先 degraded，样本够了再升 safe');
  // 哈希链完整
  const report = audit.verify();
  assert.strictEqual(report.ok, true);
  // 健康向量确实写入链（含 health 字段）
  const content = readFileSync(path, 'utf8');
  assert.ok(content.includes('supervisor.transition'));
  assert.ok(content.includes('"health"'));
});

test('attemptRecovery 保守：窗口仍有失败不强行升；健康恢复后自动回落 nominal', () => {
  const s = make({ windowSize: 4, safeThreshold: 0.5, lockAfterConsecutiveFailures: 100 });
  for (let i = 0; i < 4; i += 1) s.report('shell', 'failure'); // 4/4 ⇒ safe（危险工具失败）
  assert.strictEqual(s.mode(), 'safe');
  // 窗口内仍有失败（failureRate 1.0 > 0.5），不强行升
  assert.strictEqual(s.attemptRecovery(), 'safe');
  // 覆盖窗口为全成功 → 健康恢复 → 自动回落 nominal
  for (let i = 0; i < 4; i += 1) s.report('shell', 'success');
  assert.strictEqual(s.mode(), 'nominal');
});

test('F16：attemptRecovery 在统计未转好时不动，转好后只回升一级（逐级语义）', () => {
  // 口径（2026-09-26 审计 F16）：自动回落是有意设计（见下一条与既有用例 8），
  // 本方法只是给调用方的**显式提前量**，语义是「至多回升一级」。
  const s = new SupervisorKernel({
    windowSize: 8,
    safeThreshold: 0.5,
    lockAfterConsecutiveFailures: 100,
  });
  for (let i = 0; i < 8; i += 1) s.report('shell', 'failure');
  assert.strictEqual(s.mode(), 'safe', '前置条件：高失败率应到 safe');
  assert.strictEqual(s.attemptRecovery(), 'safe', '窗口满是失败 ⇒ 不得回升');
  for (let i = 0; i < 4; i += 1) s.report('shell', 'success');
  // 窗口 4/8 = 0.5 失败率（未越 safeThreshold）⇒ 允许回升一级。
  const after = s.attemptRecovery();
  assert.ok(after === 'degraded' || after === 'nominal', `应回升（实际 ${after}）`);
});

test('F16：健康向量转好时**会**自动回落（口径按事实登记，非单向收紧）', () => {
  const s = new SupervisorKernel({
    windowSize: 4,
    safeThreshold: 0.5,
    lockAfterConsecutiveFailures: 100,
  });
  for (let i = 0; i < 4; i += 1) s.report('shell', 'failure');
  assert.strictEqual(s.mode(), 'safe');
  for (let i = 0; i < 4; i += 1) s.report('shell', 'success');
  assert.strictEqual(s.mode(), 'nominal', '窗口全成功后自动回落（既有语义，文档已按事实更正）');
});
