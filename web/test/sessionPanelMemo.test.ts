// 会话面板 memo 护栏（2026-11-01 前端性能批）。
//
// ## 缺陷形态
//
// App 每帧重建 renderBody 的内联闭包与内联 style，SessionPanel 因此随**每条 SSE 事件**
// 全量重渲染（800 行组件体 + 整个会话列表），尽管它的数据（sessions / 宽度 / 开合态）
// 在绝大多数事件里根本没变。
//
// ## 修法与判据
//
// ① `SessionPanel` 以 `memo()` 包层（源码处包，任何消费点都受益）；② App 侧把回调束与
// style 收拢成 useMemo 产物（内联闭包会让浅比较恒不等，memo 形同虚设）；③ 上下文值按
// 稀疏字段 memo（api/toast/dialog 全程稳定，sessionId/sessionTick/workspaceEpoch 真变化
// 才换身份）。
//
// ## 为什么不用 React.Profiler 数 commit
//
// 实测 Profiler 在整树 bail-out 时也会因自身元素重建触发 onRender（伪信号，actualDuration
// ≈0 但非零条目），判据会假红。本判据改用**精确信号**：memo 包装对象的 `.type` 就是内层
// 组件函数，包一层计数它的真实调用次数——函数体跑没跑，一是一二是二。
//
// 直跑（web 测试统一入口）：npm run web:test
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as React from 'react';
import { act, render } from './rtlHarness.ts';
import { AppContext } from '../src/ui/context.ts';
import type { AppContextValue } from '../src/ui/context.ts';
import type { ApiClient } from '../src/core/ApiClient.ts';

const { SessionPanel } = await import('../src/ui/components/SessionPanel.tsx');

/** 任意方法都成功返回的假 api（面板挂载期会打若干 RPC，判据只关心渲染次数）。 */
const fakeApi = new Proxy({} as ApiClient, {
  get: (_t, prop) => {
    if (prop === 'listWorkspaces') {
      return async () => ({ current: 'D:/proj', workspaces: ['D:/proj'] });
    }
    return async () => ({});
  },
});

/** 最小上下文值（api/toast/dialog 桩 + 指定的 tick）。 */
function contextValue(sessionTick: number): AppContextValue {
  return {
    api: fakeApi,
    toast: () => {},
    dialog: { confirm: async () => true, prompt: async () => null } as never,
    sessionId: null,
    sessionTick,
    workspaceEpoch: 0,
  };
}

/** 会话行最小形状（与 SessionController 判据同款）。 */
function sessionOf(id: string): Record<string, unknown> {
  return { sessionId: id, label: `会话 ${id}`, workspace: 'D:/proj', updatedAt: '', turns: 1, running: false };
}

/** 面板回调：**建一次、跨重渲染复用同一份**（复刻 App 级 useMemo 稳定回调束的语义）。 */
const stableHandlers = {
  onSelect: () => {},
  onNew: () => {},
  onOpenFile: () => {},
  onRename: () => {},
  onDelete: () => {},
  onFork: () => {},
  onArchive: () => {},
  onReorder: () => {},
  onWorkspaceSwitched: () => {},
  onWorkspaceResolved: () => {},
  onToggleScope: () => {},
  onOpenPane: () => {},
  onOpenSettings: () => {},
};

/** 面板 props：外层对象每次新建（模拟 renderBody 每帧建树），成员身份由调用方控制。 */
function panelProps(sessions: Record<string, unknown>[], style: Record<string, string>): Record<string, unknown> {
  return {
    ...stableHandlers,
    sessions,
    currentThreadId: 's1',
    scopeAll: false,
    activePane: 'chat',
    connected: true,
    streamState: 'idle',
    open: true,
    style,
  };
}

/** 让挂载期内部异步全部落地：微任务链（listWorkspaces→setWsPath→listFs→setTree）＋
 * 一次性宏任务（实测 300ms 沉降后第二个同长窗口 +0 次调用，判据因此确定性）。 */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 给 memo 包装对象的内层函数包一层调用计数，返回还原器（用例结束必须还原）。 */
function countInnerRenders(): { readonly calls: () => number; readonly restore: () => void } {
  const memoObj = SessionPanel as unknown as { type: (props: never) => unknown };
  const original = memoObj.type;
  let calls = 0;
  memoObj.type = (props: never) => {
    calls += 1;
    return original(props);
  };
  return { calls: () => calls, restore: () => { memoObj.type = original; } };
}

test('SessionPanel memo：props 身份不变的重渲染函数体不执行（SSE 事件 patch 不再拖动侧栏）', async () => {
  const counter = countInnerRenders();
  try {
    // 稳定身份：sessions 数组与 style 对象跨重渲染保持同一份（App 级 useMemo 的产物语义）。
    const sessions = [sessionOf('s1')];
    const style = { width: '280px' };
    const ctx = contextValue(0);
    const tree = () =>
      React.createElement(
        AppContext.Provider,
        { value: ctx },
        React.createElement(SessionPanel as never, panelProps(sessions, style)),
      );
    const ui = render(tree());
    await quiesce();
    const settled = counter.calls();
    assert.ok(settled > 0, '挂载期至少渲染过一次（信号本身必须活着）');
    // props 外层对象每帧新建、成员身份全部不变 ⇒ memo 浅比较通过 ⇒ 函数体不得再执行。
    ui.rerender(tree());
    await quiesce();
    ui.rerender(tree());
    await quiesce();
    assert.strictEqual(counter.calls(), settled, 'props 身份不变时组件函数体不得执行（memo 未生效或身份被破坏）');
    ui.unmount();
  } finally {
    counter.restore();
  }
});

test('SessionPanel memo：会话数据真变化必须照常渲染（不许过度 memo）', async () => {
  const counter = countInnerRenders();
  try {
    const style = { width: '280px' };
    const ctx = contextValue(0);
    const sessionsA = [sessionOf('s1')];
    const sessionsB = [sessionOf('s1'), sessionOf('s2')];
    const tree = (sessions: Record<string, unknown>[]) =>
      React.createElement(
        AppContext.Provider,
        { value: ctx },
        React.createElement(SessionPanel as never, panelProps(sessions, style)),
      );
    const ui = render(tree(sessionsA));
    await quiesce();
    const settled = counter.calls();
    ui.rerender(tree(sessionsB));
    await quiesce();
    assert.ok(counter.calls() > settled, 'sessions 数组身份变化必须触发重渲染（否则新会话不出现在侧栏）');
    ui.unmount();
  } finally {
    counter.restore();
  }
});

test('SessionPanel memo：context 值变化必须照常到达（sessionTick 回合级刷新语义不被 memo 挡）', async () => {
  const counter = countInnerRenders();
  try {
    const sessions = [sessionOf('s1')];
    const style = { width: '280px' };
    const tree = (ctx: AppContextValue) =>
      React.createElement(
        AppContext.Provider,
        { value: ctx },
        React.createElement(SessionPanel as never, panelProps(sessions, style)),
      );
    const ui = render(tree(contextValue(0)));
    await quiesce();
    const settled = counter.calls();
    // props 完全不变，只有 context 值换身份（回合推进 +1）⇒ 消费者必须照常重渲染。
    ui.rerender(tree(contextValue(1)));
    await quiesce();
    assert.ok(counter.calls() > settled, 'context 值变化必须触发消费者重渲染（回合级数据刷新语义）');
    ui.unmount();
  } finally {
    counter.restore();
  }
});
