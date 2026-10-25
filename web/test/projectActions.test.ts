// @vitest-environment jsdom
// SessionPanel 项目动作：跨项目「新建线程」必须先切项目，失败不新建。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { byClass, byTag, facadeOf } from './domFacade.ts';
import { SessionPanel } from '../src/ui/components/SessionPanel.tsx';

test('点击项目“+”先切换项目，再新建会话', async () => {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    async listWorkspaces() {
      return { current: 'D:\\work\\alpha', workspaces: ['D:\\work\\alpha', 'D:\\work\\beta'] };
    },
    async listFs() {
      return { tree: [] };
    },
    async switchWorkspace(path: string) {
      calls.push(`switch:${path}`);
      return { ok: true, workspace: path };
    },
  };
  const ui = await renderFacadeAsync(SessionPanel, {
    props: {
      sessions: [],
      currentThreadId: null,
      onSelect: () => {},
      onNew: () => calls.push('new'),
      onOpenFile: () => {},
      onRename: () => {},
      onDelete: () => {},
      onFork: () => {},
      open: true,
      style: {},
    },
    responses,
  });
  const tree = (): ReturnType<typeof facadeOf> => facadeOf(ui.container.firstElementChild);
  const trigger = byTag(tree(), 'button').find((n) => n.props['className'] === 'ws-switch-btn');
  assert.ok(trigger !== undefined);
  fireEvent.click(trigger.el);
  await waitFor(() => assert.strictEqual(byClass(tree(), 'ws-project').length, 2));
  const plus = byClass(tree(), 'ws-project-act').find(
    (n) => n.props['aria-label'] === '在 beta 新建线程',
  );
  assert.ok(plus !== undefined);
  await act(async () => {
    fireEvent.click(plus.el);
    await Promise.resolve();
  });
  assert.deepStrictEqual(calls, ['switch:D:\\work\\beta', 'new']);
});

test('切换项目失败时不得新建会话', async () => {
  const calls: string[] = [];
  const ui = await renderFacadeAsync(SessionPanel, {
    props: {
      sessions: [],
      currentThreadId: null,
      onSelect: () => {},
      onNew: () => calls.push('new'),
      onOpenFile: () => {},
      onRename: () => {},
      onDelete: () => {},
      onFork: () => {},
      open: true,
      style: {},
    },
    responses: {
      listWorkspaces: async () => ({
        current: 'D:\\work\\alpha',
        workspaces: ['D:\\work\\alpha', 'D:\\work\\beta'],
      }),
      listFs: async () => ({ tree: [] }),
      switchWorkspace: async () => {
        throw new Error('boom');
      },
    },
  });
  const tree = (): ReturnType<typeof facadeOf> => facadeOf(ui.container.firstElementChild);
  const trigger = byTag(tree(), 'button').find((n) => n.props['className'] === 'ws-switch-btn');
  assert.ok(trigger !== undefined);
  fireEvent.click(trigger.el);
  await waitFor(() => assert.strictEqual(byClass(tree(), 'ws-project').length, 2));
  const plus = byClass(tree(), 'ws-project-act').find(
    (n) => n.props['aria-label'] === '在 beta 新建线程',
  );
  assert.ok(plus !== undefined);
  await act(async () => {
    fireEvent.click(plus.el);
    await Promise.resolve();
  });
  assert.deepStrictEqual(calls, []);
});
