/**
 * 陈旧读守卫**对 shell 改动可见**的回归（2026-09-26 审计 A6）。
 *
 * 缺陷现场：账本只在 `read_file` 与三个 fs 写工具之间闭环，**完全不知道 shell 的改动**。
 * 于是 `read_file(a)` → `shell: echo x > a` → `write_file(a)` 这条链上，第三步会拿着
 * 「陈旧但账本认为新鲜」的指纹把 shell 的改动静默抹掉。
 *
 * 修法是**保守失效**（宁可少拦不可误拦）：命令文本里出现某条已记账路径的绝对形式或工作区
 * 相对形式，就丢掉该条 —— 丢记录只会让后续写入不再被拦（等价于改造前行为），不会误拦。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { FileContentLedger } from '../../src/adapters/tool/fs/fileContentLedger.js';

const ROOT = join('D:', 'ws');

test('A6：命令里出现绝对路径 ⇒ 该文件记录被失效（后续写入不再被陈旧指纹误放行）', () => {
  const ledger = new FileContentLedger();
  const target = join(ROOT, 'a.ts');
  ledger.remember(target, 'const a = 1;\n');
  assert.strictEqual(ledger.size(), 1);
  const forgotten = ledger.forgetMentionedIn(`echo x > "${target}"`, ROOT);
  assert.strictEqual(forgotten, 1);
  assert.strictEqual(ledger.size(), 0);
  // 失效后：磁盘内容即使背离原指纹也不再判为冲突（等价于「需要重新读」的弱化形态）。
  assert.strictEqual(ledger.changedSince(target, '被 shell 改过\n'), false);
});

test('A6：命令里出现工作区相对路径同样失效', () => {
  const ledger = new FileContentLedger();
  const target = join(ROOT, 'src', 'b.ts');
  ledger.remember(target, 'b\n');
  assert.strictEqual(ledger.forgetMentionedIn('sed -i s/a/b/ src/b.ts', ROOT), 1);
  assert.strictEqual(ledger.size(), 0);
});

test('A6：未提及的文件记录必须保留（不得整表清空）', () => {
  const ledger = new FileContentLedger();
  const touched = join(ROOT, 'a.ts');
  const untouched = join(ROOT, 'c.ts');
  ledger.remember(touched, 'a\n');
  ledger.remember(untouched, 'c\n');
  assert.strictEqual(ledger.forgetMentionedIn('echo x > a.ts', ROOT), 1);
  assert.strictEqual(ledger.changedSince(untouched, '外部改过\n'), true, '未提及者仍须受保护');
});

test('A6：空命令 / 空账本零成本（不遍历、不抛错）', () => {
  const ledger = new FileContentLedger();
  assert.strictEqual(ledger.forgetMentionedIn('', ROOT), 0);
  ledger.remember(join(ROOT, 'a.ts'), 'a\n');
  assert.strictEqual(ledger.forgetMentionedIn('   ', ROOT), 0);
  assert.strictEqual(ledger.size(), 1);
});

test('A6：路径匹配是子串判定（保守方向 = 多失效、不误拦）', () => {
  const ledger = new FileContentLedger();
  const target = join(ROOT, 'a.ts');
  ledger.remember(target, 'a\n');
  // `cp a.ts a.ts.bak` 这类形态也会命中 —— 属刻意的保守：多失效一次不影响正确性。
  assert.strictEqual(ledger.forgetMentionedIn('cp a.ts a.ts.bak', ROOT), 1);
});
