/**
 * 堆栈帧定位提取单测（P1-⑩，零依赖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StackFrameParser } from '../../src/adapters/tool/verify/stackFrameParser.js';

test('Node/Jest 风格：at fn (file:line:col) 解析为 文件:行', () => {
  const raw = ['not ok 1 - 用例', '    at Object.<anonymous> (src/a/b.ts:12:34)'].join('\n');
  assert.deepStrictEqual([...StackFrameParser.locate(raw)], ['src/a/b.ts:12']);
});

test('Node 无括号形态：at file:line:col', () => {
  const raw = '    at src/util/x.mjs:7:1';
  assert.deepStrictEqual([...StackFrameParser.locate(raw)], ['src/util/x.mjs:7']);
});

test('Python traceback：File "x.py", line N 解析为 文件:行', () => {
  const raw = [
    'Traceback (most recent call last):',
    '  File "/app/tests/test_x.py", line 42, in test_a',
  ].join('\n');
  assert.deepStrictEqual([...StackFrameParser.locate(raw)], ['/app/tests/test_x.py:42']);
});

test('pytest 单行与 Rust/Go/Java 形态', () => {
  assert.deepStrictEqual(
    [...StackFrameParser.locate('tests/test_b.py:9: AssertionError')],
    ['tests/test_b.py:9'],
  );
  assert.deepStrictEqual([...StackFrameParser.locate(' --> src/main.rs:88:5')], ['src/main.rs:88']);
  assert.deepStrictEqual(
    [...StackFrameParser.locate('/app/pkg/x.go:31 +0x1f')],
    ['/app/pkg/x.go:31'],
  );
  assert.deepStrictEqual(
    [...StackFrameParser.locate('    at com.a.B.c(B.java:12)')],
    ['B.java:12'],
  );
});

test('噪声帧被剔除（node:internal / node_modules / 非文件片段）', () => {
  const raw = [
    '    at node:internal/modules/cjs/loader:1234:14',
    '    at /repo/node_modules/pkg/index.js:5:5',
    '    at new Promise (<anonymous>)',
    '    at Object.<anonymous> (src/real.ts:3:1)',
  ].join('\n');
  assert.deepStrictEqual([...StackFrameParser.locate(raw)], ['src/real.ts:3']);
});

test('去重保序 + 上限裁剪 + 空输入', () => {
  const raw = ['at a.ts:1:1', 'at a.ts:1:1', 'at b.ts:2:1', 'at c.ts:3:1'].join('\n');
  assert.deepStrictEqual([...StackFrameParser.locate(raw, 2)], ['a.ts:1', 'b.ts:2']);
  assert.deepStrictEqual([...StackFrameParser.locate(raw, 0)], ['a.ts:1']);
  assert.deepStrictEqual([...StackFrameParser.locate('')], []);
  assert.deepStrictEqual([...StackFrameParser.locate('nothing here')], []);
});

test('反斜杠路径归一化为正斜杠', () => {
  const raw = '    at fn (src\\win\\x.ts:4:2)';
  assert.deepStrictEqual([...StackFrameParser.locate(raw)], ['src/win/x.ts:4']);
});
