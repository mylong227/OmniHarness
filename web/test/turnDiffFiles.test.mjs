// 回合变更文件清单解析器契约测试（对标 Codex「Edited N files」卡片的数据面）。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/turnDiffFiles.test.mjs 直跑。
import assert from 'node:assert/strict';
import { test } from 'vitest';

const { parseTurnDiffFiles, turnDiffTotals } = await import('../src/ui/models/TurnDiffFiles.ts');

/** 双文件样例：一个改写、一个新建（新建文件 before 为空 ⇒ 全为 + 行）。 */
const TWO_FILES = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '--- a/src/new.ts',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const k = 1;',
  '+export const k2 = 2;',
].join('\n');

test('空串/无文件段解析为空数组', () => {
  assert.deepEqual(parseTurnDiffFiles(''), []);
  assert.deepEqual(parseTurnDiffFiles('杂散文本\n无文件头'), []);
});

test('双文件 diff：按文件拆分、路径与增删正确', () => {
  const files = parseTurnDiffFiles(TWO_FILES);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.ts');
  assert.equal(files[0].added, 1);
  assert.equal(files[0].deleted, 1);
  assert.equal(files[1].path, 'src/new.ts');
  assert.equal(files[1].added, 2);
  assert.equal(files[1].deleted, 0);
});

test('+++ / --- 头不计入增删行数', () => {
  const files = parseTurnDiffFiles(TWO_FILES);
  // 若头被误计，a.ts 会是 +2 −2；new.ts 会是 +3 −1。
  assert.equal(files[0].added, 1);
  assert.equal(files[0].deleted, 1);
  assert.equal(files[1].added, 2);
  assert.equal(files[1].deleted, 0);
});

test('正文含 --- a/ 样式的行不误切分（删除行带 - 前缀、上下文行带空格）', () => {
  const tricky = [
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,3 +1,3 @@',
    ' --- a/fake', // 上下文行（带空格前缀）
    '---- a/fake2', // 删除行：'-' + '--- a/fake2'
    '+--- a/fake3', // 新增行：'+' + '--- a/fake3'
  ].join('\n');
  const files = parseTurnDiffFiles(tricky);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'x.txt');
  assert.equal(files[0].added, 1);
  assert.equal(files[0].deleted, 1);
});

test('totals：合计为各文件之和', () => {
  const totals = turnDiffTotals(parseTurnDiffFiles(TWO_FILES));
  assert.deepEqual(totals, { added: 3, deleted: 1 });
});

test('每个文件段正文自带完整 diff 头（可直接喂 diff 渲染器）', () => {
  const files = parseTurnDiffFiles(TWO_FILES);
  assert.ok(files[0].text.startsWith('--- a/src/a.ts\n'));
  assert.ok(files[0].text.includes('@@ -1,3 +1,3 @@'));
});
