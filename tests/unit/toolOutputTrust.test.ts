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

test('fromToolName：工作区文件 / 记忆检索类工具 → file', () => {
  for (const name of ['read_file', 'list_dir', 'memory_search', 'recall', 'spill_read']) {
    assert.strictEqual(ToolOutputTrust.fromToolName(name), 'file', name);
  }
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
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('file'), 2);
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('local'), 3);
});

test('labelOf：返回中文标签', () => {
  assert.strictEqual(ToolOutputTrust.labelOf('external'), '外部抓取');
  assert.strictEqual(ToolOutputTrust.labelOf('file'), '文件内容');
  assert.strictEqual(ToolOutputTrust.labelOf('local'), '本机命令');
  assert.strictEqual(ToolOutputTrust.labelOf('unknown'), '未知来源');
});

test('isUntrusted：external/unknown 为不可信档', () => {
  assert.strictEqual(ToolOutputTrust.isUntrusted('external'), true);
  assert.strictEqual(ToolOutputTrust.isUntrusted('unknown'), true);
  assert.strictEqual(ToolOutputTrust.isUntrusted('file'), false);
  assert.strictEqual(ToolOutputTrust.isUntrusted('local'), false);
});
