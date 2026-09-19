import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GlobMatcher } from '../../src/util/globMatcher.js';

test('GlobMatcher：不含 / 的模式按基名匹配（任意深度）', () => {
  const matcher = new GlobMatcher('*.ts');
  assert.strictEqual(matcher.test('a.ts'), true);
  assert.strictEqual(matcher.test('src/deep/a.ts'), true);
  assert.strictEqual(matcher.test('a.js'), false);
});

test('GlobMatcher：**/ 可匹配零层目录', () => {
  const matcher = new GlobMatcher('src/**/*.ts');
  assert.strictEqual(matcher.test('src/a.ts'), true);
  assert.strictEqual(matcher.test('src/a/b.ts'), true);
  assert.strictEqual(matcher.test('other/a.ts'), false);
});

test('GlobMatcher：* 不跨目录、? 匹配单字符', () => {
  assert.strictEqual(GlobMatcher.matches('src/*.ts', 'src/a.ts'), true);
  assert.strictEqual(GlobMatcher.matches('src/*.ts', 'src/x/a.ts'), false);
  assert.strictEqual(GlobMatcher.matches('a?.ts', 'ab.ts'), true);
  assert.strictEqual(GlobMatcher.matches('a?.ts', 'abc.ts'), false);
});

test('GlobMatcher：{a,b} 交替与 [abc] 字符集', () => {
  const alternation = new GlobMatcher('*.{js,ts}');
  assert.strictEqual(alternation.test('a.js'), true);
  assert.strictEqual(alternation.test('a.ts'), true);
  assert.strictEqual(alternation.test('a.py'), false);
  assert.strictEqual(GlobMatcher.matches('[abc]x.ts', 'bx.ts'), true);
  assert.strictEqual(GlobMatcher.matches('[!abc]x.ts', 'bx.ts'), false);
});

test('GlobMatcher：正则元字符按字面量处理，不被当语法', () => {
  assert.strictEqual(GlobMatcher.matches('a.ts', 'a.ts'), true);
  assert.strictEqual(GlobMatcher.matches('a.ts', 'aXts'), false);
  assert.strictEqual(GlobMatcher.matches('a+b.ts', 'a+b.ts'), true);
});

test('GlobMatcher：Windows 反斜杠与 ./ 前缀归一后结论一致', () => {
  assert.strictEqual(GlobMatcher.matches('src/**/*.ts', 'src\\a\\b.ts'), true);
  assert.strictEqual(GlobMatcher.matches('./src/*.ts', 'src/a.ts'), true);
  assert.strictEqual(GlobMatcher.matches('src/*.ts', './src/a.ts'), true);
});
