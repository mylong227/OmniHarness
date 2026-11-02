/**
 * 规范 JSON 判据：键序稳定、undefined 省略、数组保持顺序、深层输入 fail-closed。
 *
 * 这些规则是哈希链的**算法契约**（HTML 内嵌复核器实现了同一套）；任何一条改动都会让
 * 已发出的报告全部"断链"，因此必须逐字节钉住。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AuditCanonical } from '../../src/apps/audit/auditCanonical.ts';

test('① 对象键按 UTF-16 码元升序（与插入顺序无关）', () => {
  const text = AuditCanonical.stringify({ b: 1, a: { d: 2, c: 3 } });
  assert.strictEqual(text, '{"a":{"c":3,"d":2},"b":1}');
});

test('② 值为 undefined 的键被省略；数组里的 undefined 写 null', () => {
  assert.strictEqual(
    AuditCanonical.stringify({ a: undefined, b: 1, list: [1, undefined, 2] }),
    '{"b":1,"list":[1,null,2]}',
  );
});

test('③ 字符串转义与 JSON.stringify 一致（引号 / 反斜杠 / 换行 / 控制字符）', () => {
  const value = 'a"b\\c\nd\u0001';
  assert.strictEqual(AuditCanonical.stringify(value), JSON.stringify(value));
});

test('④ 数字 / 布尔 / null 的表示与 JSON.stringify 一致（含 NaN / Infinity ⇒ null）', () => {
  assert.strictEqual(
    AuditCanonical.stringify({ n: -0, nan: Number.NaN, inf: Infinity, t: true }),
    '{"inf":null,"n":0,"nan":null,"t":true}',
  );
  assert.strictEqual(AuditCanonical.stringify(null), 'null');
  assert.strictEqual(AuditCanonical.stringify(undefined), 'null');
});

test('⑤ 嵌套超过上限即抛错（外部报告是坏输入，不得炸栈）', () => {
  let value: unknown = 1;
  for (let index = 0; index < AuditCanonical.MAX_DEPTH + 2; index += 1) {
    value = { next: value };
  }
  assert.throws(() => AuditCanonical.stringify(value), /嵌套超过/);
});

test('⑥ 函数 / symbol 不是 JSON 模型：对象里省略、数组里 null', () => {
  const value = { fn: () => 1, arr: [() => 1, Symbol('x')], ok: true };
  assert.strictEqual(AuditCanonical.stringify(value), '{"arr":[null,null],"ok":true}');
});
