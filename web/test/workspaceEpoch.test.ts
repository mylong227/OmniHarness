// 工作区切换的**界面同步**判据（2026-10-28 前端审计待办 ③）。
//
// ## 缺陷形态
//
// 打开别家项目的会话时，`SessionProjectBinding.ensure` 会在服务端 `workspace.switch`（会话跟着
// 项目走），但界面收不到通知：`SessionPanel` 的项目名 / 面包屑 / 文件树来自它自己的一次
// `listWorkspaces`，只在挂载与「用户手动切项目」时更新。结果侧栏还停在旧项目，点旧树里的
// 文件会落到新工作区而失败。
//
// ## 修法与判据
//
// 新增 `AppState.workspaceEpoch`（只有**项目身份真的变了**才 +1，不同于随事件乱跳的 sessionTick）：
//   ① 控制器在隐式切项目（loadThread）与显式切项目（onWorkspaceSwitched）时 +1；
//   ② `SessionPanel` 把 `workspaceEpoch` 放进 `listWorkspaces` 的依赖 ⇒ 代数一变就重取。
// 本判据两条都钉住：控制器+1、面板真的重取（用 rerender 换 context，断言 RPC 次数）。
//
// 直跑（web 测试统一入口）：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as React from 'react';
import { act, render } from './rtlHarness.ts';
import { AppContext } from '../src/ui/context.ts';
import { SessionController } from '../src/ui/controllers/SessionController.ts';
import { SessionPanel } from '../src/ui/components/SessionPanel.tsx';

/** 一次渲染要用的最小上下文值。 */
function contextValue(api: unknown, workspaceEpoch: number) {
  return {
    api: api as never,
    toast: () => {},
    dialog: { confirm: async () => true, prompt: async () => null } as never,
    sessionId: null,
    sessionTick: 0,
    workspaceEpoch,
  };
}

/** 面板必需的最小 props（只保留渲染路径真的读到的字段）。 */
const PANEL_PROPS = {
  sessions: [],
  currentThreadId: null,
  onSelect: () => {},
  onNew: () => {},
  onOpenFile: () => {},
  onRename: () => {},
  onDelete: () => {},
  onFork: () => {},
  onOpenPane: () => {},
  open: true,
  style: {},
};

test('SessionPanel：workspaceEpoch 变化必须重取项目清单（侧栏项目名/文件树随切项目刷新）', async () => {
  let listWorkspacesCalls = 0;
  const api = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'listWorkspaces') {
          return async () => {
            listWorkspacesCalls += 1;
            return { current: 'D:/proj', workspaces: ['D:/proj'] };
          };
        }
        return async () => ({});
      },
    },
  );

  const tree = (epoch: number) =>
    React.createElement(
      AppContext.Provider,
      { value: contextValue(api, epoch) },
      React.createElement(SessionPanel as never, PANEL_PROPS),
    );

  const ui = render(tree(0));
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(listWorkspacesCalls, 1, '挂载时取一次项目清单');
  // 项目身份变了（打开别家项目的会话 / 用户切项目）⇒ 代数 +1，必须再取一次。
  ui.rerender(tree(1));
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(listWorkspacesCalls, 2, '代数变化必须触发重取（否则侧栏停在旧项目）');
  // 代数不变的重渲染不得再打 RPC（否则每个回合都会刷一串 workspace.list）。
  ui.rerender(tree(1));
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(listWorkspacesCalls, 2, '代数不变时不得重复取数');
});

test('SessionController：隐式切项目（loadThread）与显式切项目（onWorkspaceSwitched）都 +1', async () => {
  const state = {
    currentThreadId: null as string | null,
    sessions: [] as { id: string }[],
    events: [] as unknown[],
    toolResults: {} as Record<string, unknown>,
    liveInputs: [] as unknown[],
    streamText: '',
    finalizedStreamText: '',
    busy: false,
    activeTool: null as string | null,
    historyHasMore: false,
    oldestEventId: null as string | null,
    historyLoading: false,
    sessionTick: 0,
    workspaceEpoch: 0,
  };
  const host = {
    patch(action: Partial<typeof state> | ((prev: typeof state) => Partial<typeof state>)) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const api = {
    listSessions: async () => ({
      sessions: [{ sessionId: 's1', label: 'x', workspace: 'D:/other', updatedAt: '', turns: 1, running: false }],
    }),
    listWorkspaces: async () => ({ current: 'D:/cur', workspaces: ['D:/cur', 'D:/other'] }),
    switchWorkspace: async () => ({ ok: true, workspace: 'D:/other' }),
    getThread: async () => ({ items: [], hasMore: false }),
    modesSet: async () => ({ ok: true }),
  };
  const services = {
    api,
    toast: () => {},
    navigate: () => {},
    reducers: {
      appendTextDelta: (a: string, b: string) => a + b,
      ingestEvent: () => ({}),
      mergeToolResult: () => ({}),
    },
  };
  const ctrl = new SessionController(host as never, services as never);
  await ctrl.loadThread('s1');
  assert.strictEqual(state.workspaceEpoch, 1, '隐式切项目必须 +1（打开别家项目的会话）');
  ctrl.onWorkspaceSwitched();
  assert.strictEqual(state.workspaceEpoch, 2, '显式切项目必须 +1');
});
