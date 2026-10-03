/**
 * P4 工具输出来源信任级单测。
 *
 * 覆盖：工具名 → 信任级映射（含大小写/空白归一）、未登记工具回落 `unknown`（fail-closed）、
 * 各档弱证据阈值、中文标签与「不可信」判据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolOutputTrust } from '../../src/security/toolOutputTrust.js';

test('fromToolName：公网抓取类工具 → external', () => {
  assert.strictEqual(ToolOutputTrust.fromToolName('web_search'), 'external');
  assert.strictEqual(ToolOutputTrust.fromToolName('web_fetch'), 'external');
});

test('fromToolName：工作区文件类工具 → file（记忆已单列，见下一例）', () => {
  for (const name of ['read_file', 'list_dir', 'spill_read']) {
    assert.strictEqual(ToolOutputTrust.fromToolName(name), 'file', name);
  }
});

test('fromToolName：记忆检索 → memory 档（G5 收紧：不与工作区文件同档）', () => {
  // 理由：记忆**跨会话持久**（一次注入写进去，之后每次召回都带回来）且**来源不可追溯**
  //（抽取器总结的可能是 web_search / web_fetch 的产物）。持久化的注入面比一次性抓取更危险。
  for (const name of ['memory_search', 'recall']) {
    assert.strictEqual(ToolOutputTrust.fromToolName(name), 'memory', name);
  }
  assert.strictEqual(
    ToolOutputTrust.weakEvidenceThreshold('memory'),
    1,
    '记忆必须与 external 同档（阈值 1）；放宽只能经 promptInjectionGuardThresholds 显式覆盖',
  );
});

test('fromToolName：本机进程执行类工具 → local', () => {
  assert.strictEqual(ToolOutputTrust.fromToolName('shell'), 'local');
  assert.strictEqual(ToolOutputTrust.fromToolName('run_code'), 'local');
});

test('fromToolName：未登记工具回落 unknown（保守，不会放松）', () => {
  for (const name of ['apply_patch', 'write_file', 'plan_read', 'todo_write', 'delegate', '']) {
    assert.strictEqual(ToolOutputTrust.fromToolName(name), 'unknown', name);
  }
});

test('fromToolName：大小写与首尾空白归一', () => {
  assert.strictEqual(ToolOutputTrust.fromToolName('  WEB_SEARCH '), 'external');
  assert.strictEqual(ToolOutputTrust.fromToolName('Shell'), 'local');
  assert.strictEqual(ToolOutputTrust.fromToolName('Read_File'), 'file');
});

test('weakEvidenceThreshold：来源越不可信阈值越低', () => {
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('external'), 1);
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('unknown'), 1);
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('memory'), 1, '记忆与 external 同档');
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('file'), 2);
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('local'), 3);
});

test('labelOf：返回中文标签', () => {
  assert.strictEqual(ToolOutputTrust.labelOf('external'), '外部抓取');
  assert.strictEqual(ToolOutputTrust.labelOf('memory'), '长期记忆');
  assert.strictEqual(ToolOutputTrust.labelOf('file'), '文件内容');
  assert.strictEqual(ToolOutputTrust.labelOf('local'), '本机命令');
  assert.strictEqual(ToolOutputTrust.labelOf('unknown'), '未知来源');
});

test('isUntrusted：external/unknown/memory 为不可信档', () => {
  assert.strictEqual(ToolOutputTrust.isUntrusted('external'), true);
  assert.strictEqual(ToolOutputTrust.isUntrusted('unknown'), true);
  assert.strictEqual(ToolOutputTrust.isUntrusted('memory'), true, '记忆档属不可信（弱证据即拦）');
  assert.strictEqual(ToolOutputTrust.isUntrusted('file'), false);
  assert.strictEqual(ToolOutputTrust.isUntrusted('local'), false);
});

test('setThresholdOverride：运行时覆盖基线阈值', () => {
  try {
    // 把 local 档阈值从 3 降到 1，使原本需 3 条弱证据的本机命令输出变成 1 条即拦。
    ToolOutputTrust.setThresholdOverride({ local: 1 });
    assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('local'), 1, '覆盖应生效');
    assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('external'), 1, '未覆盖档沿用基线');
    assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('file'), 2, '未覆盖档沿用基线');
  } finally {
    ToolOutputTrust.resetThresholdOverride();
  }
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('local'), 3, '复位后应回基线');
});

test('setThresholdOverride：部分覆盖只改指定档，不影响其余', () => {
  try {
    ToolOutputTrust.setThresholdOverride({ file: 5 });
    assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('file'), 5);
    assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('external'), 1, 'external 不受影响');
    assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('local'), 3, 'local 不受影响');
  } finally {
    ToolOutputTrust.resetThresholdOverride();
  }
});
