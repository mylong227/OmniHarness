// 航天级监督内核（I-P0-3 / FDIR）单元测试。
// 覆盖：FDIR 分级降级、危险动作零越权、健康向量入审计哈希链、保守恢复。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisorKernel } from '../../src/supervisor/supervisorKernel.js';
import { AuditSink } from '../../src/server/auditSink.js';

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

test('危险工具失败 → safe，intercept 拒危险工具', () => {
  const s = make();
  s.report('shell', 'failure', 'boom');
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
  const s = make({ audit });
  s.onTransition((from, to) => transitions.push(`${from}->${to}`));
  s.report('shell', 'failure'); // → safe
  assert.strictEqual(s.mode(), 'safe');
  assert.ok(transitions.includes('nominal->safe'));
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
  s.report('shell', 'failure'); // → safe（危险工具失败）
  assert.strictEqual(s.mode(), 'safe');
  // 窗口内仍有失败（failureRate 1.0 > 0.5），不强行升
  assert.strictEqual(s.attemptRecovery(), 'safe');
  // 覆盖窗口为全成功 → 健康恢复 → 自动回落 nominal
  for (let i = 0; i < 4; i += 1) s.report('shell', 'success');
  assert.strictEqual(s.mode(), 'nominal');
});
