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
