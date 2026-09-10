import test from 'node:test';
import assert from 'node:assert/strict';
import { CliArgReader } from '../../src/cli/cliArgReader.js';

test('CliArgReader.value：取标志后的第一个值；缺失或尾部无值返回 undefined', () => {
  const r = new CliArgReader(['a', '--key', 'K', '--tail']);
  assert.strictEqual(r.value('--key'), 'K');
  assert.strictEqual(r.value('--missing'), undefined);
  assert.strictEqual(r.value('--tail'), undefined, '标志位于末尾无值时应返回 undefined');
  assert.strictEqual(r.value('a'), '--key', '非标志 token 也可作为锚点（与 indexOf 语义一致）');
});

test('CliArgReader.at：位置参数访问（0=子命令，越界 undefined）', () => {
  const r = new CliArgReader(['get', 'mykey']);
  assert.strictEqual(r.at(0), 'get');
  assert.strictEqual(r.at(1), 'mykey');
  assert.strictEqual(r.at(2), undefined);
});

test('CliArgReader.values：收集可重复标志，跳过无值尾随标志', () => {
  assert.deepStrictEqual(new CliArgReader(['--allow', 'a', '--allow', 'b']).values('--allow'), [
    'a',
    'b',
  ]);
  assert.deepStrictEqual(new CliArgReader(['--allow']).values('--allow'), []);
  assert.deepStrictEqual(new CliArgReader(['--allow', 'a']).values('--other'), []);
});

test('CliArgReader.number：parseInt 解析；缺失返回 undefined；非数字为 NaN', () => {
  const r = new CliArgReader(['--limit', '42', '--bad', 'x9']);
  assert.strictEqual(r.number('--limit'), 42);
  assert.strictEqual(r.number('--missing'), undefined);
  assert.ok(Number.isNaN(r.number('--bad')), '非数字值应产出 NaN（与原 flagNumber 行为逐字一致）');
});
