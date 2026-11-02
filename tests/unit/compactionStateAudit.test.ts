/**
 * 压缩后**状态审计**（U2-1，2026-10-30）。
 *
 * 缺口：压缩摘要由模型生成，可能丢掉「改过哪些文件、跑过哪些命令、还剩哪些待办」，
 * 此前这一丢失完全静默（CORE_CAPABILITY_UPGRADE §4「最后一公里的静默失效」）。
 * 审计从被折叠 head 确定性提取关键状态，与最终摘要（含台账）比对；shadow 语义——
 * 只上报（`CompactionResult.stateAudit` + warn 日志），不改摘要、不改游标。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CompactionStateAudit } from '../../src/kernel/context/compactionStateAudit.ts';
import type { ModelMessage } from '../../src/contracts/ports/model/modelMessage.ts';

/** 完整 8 段模板骨架（各节内容可换）。 */
const FULL_SUMMARY = [
  '1. 任务目标：修复登录超时',
  '2. 关键决策：改用指数退避',
  '3. 涉及文件：src/auth/session.ts',
  '4. 错误与修复：无',
  '5. 当前进度：已完成',
  '6. 下一步：无',
  '7. 关键约束：不引新依赖',
  '8. 重要事实：无',
].join('\n');

/** 一个带 toolCalls 的 assistant 消息。 */
function assistantWith(id: string, name: string, args: Record<string, unknown>): ModelMessage {
  return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] };
}

test('audit：摘要 + 台账齐全时 ok，且条数如实统计', () => {
  const summary = [
    FULL_SUMMARY,
    '## 已执行工具台账（确定性生成，用于避免重复探索）',
    '- edit src/auth/session.ts ×1',
    '- shell npm test ×1',
  ].join('\n');
  const head: readonly ModelMessage[] = [
    assistantWith('a1', 'edit', { path: 'src/auth/session.ts', old_string: 'a', new_string: 'b' }),
    assistantWith('a2', 'shell', { command: 'npm test' }),
  ];

  const result = CompactionStateAudit.audit(summary, head);

  assert.strictEqual(result.ok, true, '文件/命令都在台账里，待办为空 ⇒ 通过');
  assert.deepStrictEqual(result.missing, []);
  assert.strictEqual(result.checked.editedFiles, 1);
  assert.strictEqual(result.checked.commands, 1);
  assert.strictEqual(result.checked.openTodos, 0);
});

test('audit：摘要丢了已改文件 ⇒ missing 指名该文件', () => {
  const summary = FULL_SUMMARY.replace('src/auth/session.ts', 'src/auth/');
  const head: readonly ModelMessage[] = [
    assistantWith('a1', 'write_file', { path: 'src/auth/token.ts', content: 'x' }),
  ];

  const result = CompactionStateAudit.audit(summary, head);

  assert.strictEqual(result.ok, false);
  assert.ok(
    result.missing.some((m) => m.includes('src/auth/token.ts')),
    `缺失项应指名文件，实际：${JSON.stringify(result.missing)}`,
  );
});

test('audit：head 里有未完成待办而摘要「下一步：无」 ⇒ missing', () => {
  const head: readonly ModelMessage[] = [
    assistantWith('a1', 'todo_write', {
      todos: [
        { content: '更新 CHANGELOG', status: 'pending' },
        { content: '写测试', status: 'completed' },
      ],
    }),
  ];

  const result = CompactionStateAudit.audit(FULL_SUMMARY, head);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.checked.openTodos, 1, '只统计未完成项');
  assert.ok(
    result.missing.some((m) => m.includes('更新 CHANGELOG')),
    `缺失项应指名待办，实际：${JSON.stringify(result.missing)}`,
  );
});

test('audit：最后一次 todo_write 才生效（last-write-wins）', () => {
  const head: readonly ModelMessage[] = [
    assistantWith('a1', 'todo_write', {
      todos: [{ content: '旧待办已取消的事项', status: 'pending' }],
    }),
    assistantWith('a2', 'todo_write', {
      todos: [{ content: '新清单唯一剩余项', status: 'in_progress' }],
    }),
  ];

  const state = CompactionStateAudit.extractState(head);

  assert.deepStrictEqual(state.openTodos, ['新清单唯一剩余项'], '只取最后一次调用');
});

test('audit：Windows 路径分隔与大小写差异不误报', () => {
  const summary = FULL_SUMMARY.replace('src/auth/session.ts', 'src\\auth\\Session.ts');
  const head: readonly ModelMessage[] = [
    assistantWith('a1', 'edit', { path: 'src/auth/session.ts', old_string: 'a', new_string: 'b' }),
  ];

  const result = CompactionStateAudit.audit(summary, head);

  assert.strictEqual(
    result.ok,
    true,
    `归一化后应命中，实际缺失：${JSON.stringify(result.missing)}`,
  );
});

test('audit：摘要缺结构段 ⇒ missing 列出缺的节名', () => {
  const summary = FULL_SUMMARY.split('\n')
    .filter((line) => !line.startsWith('7.') && !line.startsWith('8.'))
    .join('\n');

  const result = CompactionStateAudit.audit(summary, []);

  assert.strictEqual(result.ok, false);
  const missingSections = result.missing.find((m) => m.startsWith('摘要缺结构段'));
  assert.ok(missingSections !== undefined, '应报告缺失的节');
  assert.ok(missingSections.includes('关键约束'), '缺「关键约束」节应被点名');
});

test('audit：head 无任何关键状态 ⇒ ok（无输入不制造噪声）', () => {
  const result = CompactionStateAudit.audit(FULL_SUMMARY, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！' },
  ]);

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.missing, []);
});

test('audit：确定性——同输入两次结果逐位一致', () => {
  const head: readonly ModelMessage[] = [
    assistantWith('a1', 'write_file', { path: 'a/b.ts', content: 'x' }),
    assistantWith('a2', 'shell', { command: 'npm run build' }),
  ];
  const one = CompactionStateAudit.audit('8. 重要事实：无', head);
  const two = CompactionStateAudit.audit('8. 重要事实：无', head);

  assert.deepStrictEqual(one, two);
});
