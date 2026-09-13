import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandGlob, commandGlob } from '../../src/adapters/approval/commandGlob.js';

test('glob：精确匹配整串（非子串）', () => {
  assert.strictEqual(commandGlob.matches('rm -rf', 'rm -rf'), true);
  assert.strictEqual(commandGlob.matches('rm -rf', 'rm -rf /'), false);
  assert.strictEqual(commandGlob.matches('rm', 'xrm'), false);
});

test('glob：* 匹配任意串（含空串）', () => {
  assert.strictEqual(commandGlob.matches('*rm -rf*', 'sudo rm -rf /tmp'), true);
  assert.strictEqual(commandGlob.matches('git *', 'git push origin main'), true);
  assert.strictEqual(commandGlob.matches('git *', 'git '), true); // * 亦匹配空串
  assert.strictEqual(commandGlob.matches('git *', 'git'), false); // 缺空格不匹配
});

test('glob：? 匹配单字符', () => {
  assert.strictEqual(commandGlob.matches('ls ?', 'ls a'), true);
  assert.strictEqual(commandGlob.matches('ls ?', 'ls ab'), false);
  assert.strictEqual(commandGlob.matches('ls ?', 'ls '), false); // ? 至少一个字符
});

test('glob：正则元字符按字面量处理（不被当正则语法）', () => {
  // `.` 是字面点，不能匹配任意字符
  assert.strictEqual(commandGlob.matches('a.b', 'a.b'), true);
  assert.strictEqual(commandGlob.matches('a.b', 'axb'), false);
  // 括号 / 管道 / 加号不被解释为正则分组或量词
  assert.strictEqual(commandGlob.matches('f(x)', 'f(x)'), true);
  assert.strictEqual(commandGlob.matches('a|b', 'a|b'), true);
  assert.strictEqual(commandGlob.matches('a|b', 'a'), false);
  assert.strictEqual(commandGlob.matches('a+b', 'a+b'), true);
  assert.strictEqual(commandGlob.matches('a+b', 'aab'), false);
});

test('glob：空模式恒不匹配（fail-closed）', () => {
  assert.strictEqual(commandGlob.matches('', 'anything'), false);
  assert.strictEqual(commandGlob.matches('', ''), false);
});

test('glob：* 亦匹配换行（s 旗标，命令可含多行）', () => {
  assert.strictEqual(commandGlob.matches('a*b', 'a\nb'), true);
});

test('glob：toRegExp 产出锚定整串正则', () => {
  const re = new CommandGlob().toRegExp('x*');
  assert.strictEqual(re.source.startsWith('^'), true);
  assert.strictEqual(re.source.endsWith('$'), true);
});
