/**
 * 生效模式单测（`src/security/enforcementModeResolver.ts` + `guardFailureResult`）。
 *
 * 锁死两件事：
 *   ① **三态语义**：`off` 不跑 / `shadow` 跑但不改行为 / `enforce` 跑且生效，且布尔历史写法
 *      （`true ⇒ enforce`、`false / undefined ⇒ off`）零行为变更；
 *   ② **D2 纪律**：未知字符串**抛错**而非静默回落成 `off`——否则「配置写错」会静默退化成
 *      「护栏失效」，与 `cliEnums.ts`「安全相关枚举必须显式校验」同一纪律。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EnforcementModeResolver } from '../../src/security/enforcementModeResolver.js';
import { guardFailureResult } from '../../src/security/promptInjectionGuard.js';
import type { ToolResult } from '../../src/ports/tool/tool.js';

const result: ToolResult = { callId: 'c1', ok: true, output: '原文' };

test('modeOf：布尔历史写法零行为变更（true ⇒ enforce，false/undefined ⇒ off）', () => {
  assert.strictEqual(EnforcementModeResolver.modeOf(true), 'enforce');
  assert.strictEqual(EnforcementModeResolver.modeOf(false), 'off');
  assert.strictEqual(EnforcementModeResolver.modeOf(undefined), 'off');
});

test('modeOf：三态字符串原样通过', () => {
  assert.strictEqual(EnforcementModeResolver.modeOf('off'), 'off');
  assert.strictEqual(EnforcementModeResolver.modeOf('shadow'), 'shadow');
  assert.strictEqual(EnforcementModeResolver.modeOf('enforce'), 'enforce');
});

test('D2：未知字符串抛错，不静默回落（否则配置写错 = 护栏静默失效）', () => {
  for (const bad of ['shdow', 'on', 'true', 'ENFORCE', '']) {
    assert.throws(
      () => EnforcementModeResolver.modeOf(bad),
      /未知的生效模式/,
      `'${bad}' 必须被拒绝而不是被当作 off`,
    );
  }
});

test('observes / applies 真值表', () => {
  assert.strictEqual(EnforcementModeResolver.observes('off'), false);
  assert.strictEqual(EnforcementModeResolver.observes('shadow'), true);
  assert.strictEqual(EnforcementModeResolver.observes('enforce'), true);
  assert.strictEqual(EnforcementModeResolver.applies('off'), false);
  assert.strictEqual(EnforcementModeResolver.applies('shadow'), false);
  assert.strictEqual(EnforcementModeResolver.applies('enforce'), true);
});

test('MODES 白名单与三态同源且无重复', () => {
  assert.deepEqual([...EnforcementModeResolver.MODES], ['off', 'shadow', 'enforce']);
  assert.strictEqual(new Set(EnforcementModeResolver.MODES).size, 3);
});

test('guardFailureResult：enforce 档 fail-closed 隔离（扫描器坏了 ≠ 护栏不存在）', () => {
  const out = guardFailureResult(result, 'enforce');
  assert.notStrictEqual(out.output, '原文', 'enforce 档不得把原文放行');
  assert.match(String(out.output), /提示注入拦截/);
  assert.strictEqual(out.callId, 'c1', '隔离不得篡改 callId');
});

test('guardFailureResult：shadow / off 档原样返回（守住「不改行为」契约）', () => {
  for (const mode of ['shadow', 'off'] as const) {
    const out = guardFailureResult(result, mode);
    assert.strictEqual(out, result, `${mode} 档必须原样返回同一对象`);
  }
});
