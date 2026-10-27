import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SupervisorHealthSignal } from '../../src/supervisor/healthSignal.ts';

test('策略拒绝识别：只认本仓门禁自己的拒绝格式（2026-10-27 收口）', () => {
  for (const text of [
    '监督内核(safe)：危险工具在安全模式下拒绝，零越权',
    '监督内核(locked)：危险工具在锁定模式下零越权拒绝',
    'approval 策略拒绝（write_file）：当前审批模式不允许该工具',
    '意图策略拒绝该动作',
    'plan mode 未批准：当前计划状态=draft，写类工具（write_file）需经用户批准后才能执行',
    'plan mode 已开启但计划端口未注入：写类工具（write_file）fail-closed 拒绝',
    'sandbox 拒绝（write_file：/tmp/x）[os] 未提供原因',
    'RBAC：该角色不允许使用此工具',
    '[沙箱拒绝] EPERM: operation not permitted',
  ]) {
    assert.strictEqual(SupervisorHealthSignal.isPolicyDenial(text), true, text);
  }
});

test('真实执行失败不误判为策略拒绝（过宽英文兜底已删，EACCES/EPERM 不再漏计）', () => {
  for (const text of [
    undefined,
    '',
    '工具执行异常: TypeError: x is not a function',
    'verify failed: expected 1 got 2',
    'command timed out after 30s',
    "EACCES: permission denied, open 'D:\\repo\\.git\\index.lock'",
    'EPERM: operation not permitted, unlink C:\\tmp\\file',
    'npm error code EPERM (依赖安装失败)',
  ]) {
    assert.strictEqual(SupervisorHealthSignal.isPolicyDenial(text), false, String(text));
  }
});

test('命令执行完但非零退出 → 不是健康失败（红测试/无命中属日常结果）', () => {
  assert.strictEqual(SupervisorHealthSignal.isCommandOutcome({ ok: false, exitCode: 1 }), true);
  assert.strictEqual(SupervisorHealthSignal.isCommandOutcome({ ok: false, exitCode: 127 }), true);
  // 成功不适用；无真实退出码（超时/信号/启动失败）→ 仍是健康失败，fail-closed 不放宽。
  assert.strictEqual(SupervisorHealthSignal.isCommandOutcome({ ok: true }), false);
  assert.strictEqual(SupervisorHealthSignal.isCommandOutcome({ ok: false }), false);
  assert.strictEqual(SupervisorHealthSignal.isCommandOutcome({ ok: false, exitCode: 0 }), false);
});

test('shell 工具的非零退出结果携带真实 exitCode（监督判定依赖此字段）', async () => {
  const { ShellTool } = await import('../../src/adapters/tool/shell/shellTool.ts');
  const tool = new ShellTool();
  const result = await tool.handle(
    { id: 'c1', name: 'shell', arguments: { command: 'node -e "process.exit(3)"' } },
    { sessionId: 'sess', workspaceRoot: process.cwd() },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.exitCode, 3, '命令确实执行完时，必须把真实退出码交给监督判定');
});
