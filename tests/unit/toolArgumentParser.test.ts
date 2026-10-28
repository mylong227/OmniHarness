import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ToolArgumentParser } from '../../src/adapters/model/toolArgumentParser.ts';

test('合法 JSON 对象原样解析', () => {
  assert.deepEqual(ToolArgumentParser.parse('{"path":"a.ts","n":1}'), { path: 'a.ts', n: 1 });
});

test('非法 JSON / 非对象 ⇒ 空对象（不抛错，保证流不中断）', () => {
  assert.deepEqual(ToolArgumentParser.parse('{oops'), {});
  assert.deepEqual(ToolArgumentParser.parse('[]'), {});
  assert.deepEqual(ToolArgumentParser.parse('null'), {});
  assert.deepEqual(ToolArgumentParser.parse('"text"'), {});
});

test('可修复畸形：截断 / 尾逗号 / 围栏 / 单引号（2026-10-28）', () => {
  assert.deepEqual(ToolArgumentParser.parse('{"a":1'), { a: 1 });
  assert.deepEqual(ToolArgumentParser.parse('{"a":"x'), { a: 'x' });
  assert.deepEqual(ToolArgumentParser.parse('{"a":1,'), { a: 1 });
  assert.deepEqual(ToolArgumentParser.parse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(ToolArgumentParser.parse("{'a':'x'}"), { a: 'x' });
  assert.deepEqual(ToolArgumentParser.parse('{"a":[1,2'), { a: [1, 2] });
});

test('不可修复 ⇒ parseDetailed 给出 error（调用方必须 fail-closed）', () => {
  const parsed = ToolArgumentParser.parseDetailed('{oops');
  assert.deepEqual(parsed.arguments, {});
  assert.ok(parsed.error !== undefined && parsed.error.includes('不是合法 JSON'));
  const ok = ToolArgumentParser.parseDetailed('{"a":1');
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(ok.repaired, true);
  assert.deepEqual(ok.arguments, { a: 1 });
});
