// `/` 技能触发解析：行首/空白后触发，绝对路径不误触；过滤与替换保持光标正确。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SlashResolver } from '../src/ui/models/SlashResolver.ts';

test('只在行首或空白后触发，路径/URL 不触发', () => {
  assert.deepStrictEqual(SlashResolver.parse('/git', 4), { start: 0, query: 'git' });
  assert.deepStrictEqual(SlashResolver.parse('请用 /git', 7), { start: 3, query: 'git' });
  assert.strictEqual(SlashResolver.parse('src/a', 5), null);
  assert.strictEqual(SlashResolver.parse('https://example.com', 19), null);
  assert.strictEqual(SlashResolver.parse('已结束 /git ', 9), null);
});

test('过滤名称/描述/标签，空查询返回全部', () => {
  const items = [
    { name: 'review', description: '代码审查', tags: ['git'] },
    { name: 'test', description: '运行测试', tags: [] },
  ];
  assert.deepStrictEqual(SlashResolver.filter(items, ''), items);
  assert.deepStrictEqual(
    SlashResolver.filter(items, 'git').map((x) => x.name),
    ['review'],
  );
  assert.deepStrictEqual(
    SlashResolver.filter(items, '测试').map((x) => x.name),
    ['test'],
  );
});

test('选中后替换 /query 并把光标放到技能名之后', () => {
  const token = SlashResolver.parse('请用 /rev 修复', 7);
  assert.ok(token !== null);
  const next = SlashResolver.apply('请用 /rev 修复', token, 'review', 7);
  assert.strictEqual(next.text, '请用 /review 修复');
  assert.strictEqual(next.caret, '请用 /review'.length);
});
