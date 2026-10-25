// @vitest-environment jsdom
// 活动面板：状态 / 待审批 / 变更摘要 / 最近事件聚合，并正确跳转既有面板。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { allText, byTag } from './domFacade.ts';
import { ActivityTab } from '../src/ui/components/tabs/ActivityTab.tsx';

test('ActivityTab：聚合忙碌/审批/变更/事件，跳转按钮可用', async () => {
  const panes: string[] = [];
  const ui = await renderFacadeAsync(ActivityTab, {
    props: {
      events: [
        { id: 'e1', type: 'user', payload: { content: '修复登录' } },
        { id: 'e2', type: 'tool_call', payload: { name: 'shell', command: 'npm test' } },
      ],
      toolResults: {},
      busy: true,
      activeTool: 'shell',
      approval: { requestId: 'r1', toolName: 'shell' },
      question: null,
      onOpenPane: (key: string) => panes.push(key),
    },
    responses: {
      listChanges: async () => ({
        source: 'git',
        files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 }],
      }),
    },
  });
  await waitFor(() => assert.match(allText(ui.node), /1 个文件 · \+2 \/ -1/u));
  const text = allText(ui.node);
  assert.match(text, /正在执行 shell/u);
  assert.match(text, /需要你处理/u);
  assert.match(text, /工具调用等待审批：shell/u);
  assert.match(text, /修复登录/u);
  const openChanges = byTag(ui.node, 'button').find((b) => allText(b) === '打开变更面板');
  assert.ok(openChanges !== undefined);
  fireEvent.click(openChanges.el);
  assert.deepStrictEqual(panes, ['changes']);
});
