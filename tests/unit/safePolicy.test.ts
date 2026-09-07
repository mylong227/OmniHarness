import { strict as assert } from 'node:assert/strict';
import { test } from 'node:test';
import { SafePolicyEvaluator, compileExpression } from '../../src/adapters/policy/safePolicy.js';
import type { PolicyFacts, PolicyRule } from '../../src/ports/policy.js';

const ev = new SafePolicyEvaluator();

function rule(name: string, when: string, effect: 'allow' | 'deny' | 'ask'): PolicyRule {
  return { name, when, effect };
}

test('空 when 规则恒真，作兜底', () => {
  const d = ev.evaluate([rule('fallback', '', 'deny')], { x: 1 });
  assert.strictEqual(d.effect, 'deny');
  assert.strictEqual(d.matchedRule, 'fallback');
});

test('首条命中即生效，后续规则不评估', () => {
  const d = ev.evaluate([rule('a', 'cmd == "rm"', 'deny'), rule('b', 'cmd == "rm"', 'allow')], {
    cmd: 'rm',
  });
  assert.strictEqual(d.effect, 'deny');
  assert.strictEqual(d.matchedRule, 'a');
});

test('无命中用默认决策（默认 ask）', () => {
  const d = ev.evaluate([rule('a', 'cmd == "rm"', 'deny')], { cmd: 'ls' });
  assert.strictEqual(d.effect, 'ask');
  assert.strictEqual(d.matchedRule, null);
});

test('默认 deny 可配置（fail-closed 更严）', () => {
  const d = ev.evaluate([rule('a', 'cmd == "rm"', 'deny')], { cmd: 'ls' }, 'deny');
  assert.strictEqual(d.effect, 'deny');
});

test('比较 + 布尔组合', () => {
  const facts: PolicyFacts = { cmd: 'rm', user: 'root', risky: true };
  assert.strictEqual(ev.test('cmd == "rm" and user == "root"', facts), true);
  assert.strictEqual(ev.test('cmd == "rm" and user == "alice"', facts), false);
  assert.strictEqual(ev.test('cmd == "ls" or risky == true', facts), true);
  assert.strictEqual(ev.test('not (cmd == "rm")', facts), false);
});

test('~ 正则匹配与 in 成员/子串', () => {
  const facts: PolicyFacts = { path: '/home/alice/secret', tags: ['net', 'exec'] };
  assert.strictEqual(ev.test('path ~ "secret"', facts), true);
  assert.strictEqual(ev.test('path ~ "^/tmp"', facts), false);
  assert.strictEqual(ev.test('"exec" in tags', facts), true);
  assert.strictEqual(ev.test('"x" in tags', facts), false);
  assert.strictEqual(ev.test('"ali" in path', facts), true); // 字符串子串
});

test('未知标识符视为 false（fail-closed，绝不意外放行）', () => {
  const facts: PolicyFacts = { cmd: 'ls' };
  assert.strictEqual(ev.test('unknown_ident', facts), false);
  assert.strictEqual(ev.test('unknown_ident == "x"', facts), false);
});

test('规则表达式解析失败 → 跳过该规则并告警，绝不意外放行', () => {
  const d = ev.evaluate(
    [rule('bad', 'cmd ==', 'allow'), rule('good', 'cmd == "ls"', 'allow')],
    { cmd: 'ls' },
    'deny',
  );
  assert.strictEqual(d.effect, 'allow');
  assert.strictEqual(d.matchedRule, 'good');
  assert.strictEqual(d.warnings.length, 1);
});

test('括号改变优先级', () => {
  const facts: PolicyFacts = { a: true, b: false, c: true };
  assert.strictEqual(ev.test('a and (b or c)', facts), true);
  assert.strictEqual(ev.test('(a and b) or c', facts), true);
});

test('compileExpression 拒绝多余 token', () => {
  assert.throws(() => compileExpression('a == 1 2'));
});
