import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TodoDockModel } from '../../web/src/ui/models/TodoDockModel.ts';

test('TodoDock：取最新 todo 快照，旧快照不重复计数', () => {
  const events = [
    { type: 'todo', payload: { todos: [{ content: '旧步骤', status: 'pending' }] } },
    { type: 'tool_call', payload: {} },
    {
      type: 'todo',
      payload: {
        todos: [
          { content: '实现', status: 'completed' },
          { content: '验证', status: 'in_progress' },
        ],
      },
    },
  ];
  const items = TodoDockModel.latest(events);
  assert.deepStrictEqual(items, [
    { content: '实现', status: 'completed' },
    { content: '验证', status: 'in_progress' },
  ]);
});

test('TodoDock：无 todo 事件或载荷损坏时返回 null（不臆造计划）', () => {
  assert.strictEqual(TodoDockModel.latest([]), null);
  assert.strictEqual(TodoDockModel.latest([{ type: 'todo', payload: { todos: 'bad' } }]), null);
});
