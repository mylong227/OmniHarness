import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SupervisorHealthSignal } from '../../src/supervisor/healthSignal.ts';

test('策略拒绝识别：监督内核/审批/沙箱/EPERM', () => {
  for (const text of [
    '监督内核(safe)：危险工具在安全模式下拒绝，零越权',
    '审批拒绝：用户未批准',
    '沙箱拒绝：路径不在工作区',
    'sandbox denied: EPERM',
    'operation not permitted (EPERM)',
  ]) {
    assert.strictEqual(SupervisorHealthSignal.isPolicyDenial(text), true, text);
  }
});

test('真实执行失败不误判为策略拒绝', () => {
  for (const text of [
    undefined,
    '',
    '工具执行异常: TypeError: x is not a function',
    'verify failed: expected 1 got 2',
    'command timed out after 30s',
  ]) {
    assert.strictEqual(SupervisorHealthSignal.isPolicyDenial(text), false, String(text));
  }
});
