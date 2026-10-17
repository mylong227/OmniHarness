// 长内容收起判定 + 压缩游标事件解析的纯逻辑单测（零 DOM 桩）。
//
// 钉住的判据：
//  1) 阈值边界：短内容不收、字符/行数任一超限即收（双阈值各验一侧）；
//  2) 预览是**取舍原文**而非改写：行数与字符双截断都生效；
//  3) 标题剥 markdown 修饰、取首个非空行、超长截断；
//  4) 压缩事件解析与后端 encodeCompactionState 格式逐字对齐，格式不符 fail-closed 返回 null。
//
// 直跑方式（先 npm run web:build）：node web/test/longContentCollapser.test.mjs

import assert from 'node:assert/strict';
import { test } from 'vitest';

const { LongContentCollapser } = await import('../src/ui/models/LongContentCollapser.js');
const { CompactionNote } = await import('../src/ui/models/CompactionNote.js');

const CHARS = LongContentCollapser.COLLAPSE_CHARS;
const LINES = LongContentCollapser.COLLAPSE_LINES;

test('shouldCollapse：短内容不收，空串安全', () => {
  assert.equal(LongContentCollapser.shouldCollapse(''), false);
  assert.equal(LongContentCollapser.shouldCollapse(undefined), false);
  assert.equal(LongContentCollapser.shouldCollapse('短回复'), false);
  assert.equal(LongContentCollapser.shouldCollapse('a'.repeat(CHARS)), false, '恰好等于阈值不收（判据是超限）');
  assert.equal(LongContentCollapser.shouldCollapse('a'.repeat(CHARS + 1)), true);
});

test('shouldCollapse：行数阈值独立生效（短行清单类内容）', () => {
  const shortLines = Array.from({ length: LINES + 1 }, (_, i) => `L${i}`).join('\n');
  assert.ok(shortLines.length < CHARS, '前提：本用例的行内容远短于字符阈值');
  assert.equal(LongContentCollapser.shouldCollapse(shortLines), true);
  const withinLines = Array.from({ length: LINES }, (_, i) => `L${i}`).join('\n');
  assert.equal(LongContentCollapser.shouldCollapse(withinLines), false);
});

test('digest：预览按行截断且不超字符上限，原文未被改写', () => {
  const lines = Array.from({ length: LINES + 20 }, (_, i) => `第${i}行内容`).join('\n');
  const d = LongContentCollapser.digest(lines);
  assert.equal(d.long, true);
  assert.ok(d.preview.split('\n').length <= LongContentCollapser.PREVIEW_LINES);
  assert.ok(d.preview.length <= LongContentCollapser.PREVIEW_CHARS);
  // 取舍而非改写：预览必须是原文前缀。
  assert.ok(lines.startsWith(d.preview), '预览必须是原文前缀（不补省略号、不改写）');
});

test('digest：超长单行触发字符截断双保险', () => {
  const oneLongLine = 'x'.repeat(LongContentCollapser.PREVIEW_CHARS * 3);
  const d = LongContentCollapser.digest(oneLongLine);
  assert.ok(d.preview.length <= LongContentCollapser.PREVIEW_CHARS);
  assert.ok(oneLongLine.startsWith(d.preview));
});

test('digest：标题取首个非空行、剥 markdown 修饰、超长截断', () => {
  assert.equal(LongContentCollapser.digest('## 项目结构分析\n\n正文').title, '项目结构分析');
  assert.equal(LongContentCollapser.digest('> 引用一行').title, '引用一行');
  assert.equal(LongContentCollapser.digest('- 列表项').title, '列表项');
  assert.equal(LongContentCollapser.digest('**加粗** 与 `码`').title, '加粗 与 码');
  assert.equal(LongContentCollapser.digest('\n\n\n  \n第三行才是标题').title, '第三行才是标题');
  assert.equal(LongContentCollapser.digest('').title, '长文内容', '空内容回退占位');
  const long = '很'.repeat(40);
  const t = LongContentCollapser.digest(long).title;
  assert.ok(t.length <= 33 && t.endsWith('…'), '超长标题截断加省略号');
});

test('digest：短内容 truncated=false（预览即全文时不得谎称还有更多）', () => {
  const d = LongContentCollapser.digest('短回复');
  assert.equal(d.long, false);
  assert.equal(d.truncated, false);
  assert.equal(d.preview, '短回复');
});

test('CompactionNote.parse：与后端 encodeCompactionState 格式逐字对齐', () => {
  const encoded = 'OMNI_COMPACTION_V1 upTo=21 hash=2a8f1f50\n【任务目标】…\n【关键结论】…';
  const parts = CompactionNote.parse(encoded);
  assert.deepEqual(parts, { upTo: 21, hash: '2a8f1f50', summary: '【任务目标】…\n【关键结论】…' });
});

test('CompactionNote.parse：fail-closed——缺正文/缺换行/格式漂移/空串都返回 null', () => {
  assert.equal(CompactionNote.parse(''), null);
  assert.equal(CompactionNote.parse(undefined), null);
  assert.equal(CompactionNote.parse('OMNI_COMPACTION_V1 upTo=21 hash=2a8f1f50'), null, '无换行=无摘要正文');
  assert.equal(CompactionNote.parse('OMNI_COMPACTION_V1 upTo=21 hash=2a8f1f50\n'), null, '摘要为空');
  assert.equal(CompactionNote.parse('OMNI_COMPACTION_V1 upTo=x hash=zz\n正文'), null, '游标非数字');
  assert.equal(CompactionNote.parse('OMNI_COMPACTION_V2 upTo=21 hash=aa\n正文'), null, '标记版本漂移');
  assert.equal(CompactionNote.parse('普通系统提示\n正文'), null, '普通 sysnote 不误判');
});
