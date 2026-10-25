// @vitest-environment jsdom
// 项目条：项目 → 线程计数、当前项目标记、无项目时不占位。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderFacade } from './rtlHarness.ts';
import { fireEvent } from '@testing-library/react';
import { allText, byClass } from './domFacade.ts';
import { renderProjectsView } from '../src/ui/components/SessionViews.tsx';
import type { SessionEntry } from '../src/ui/shared.ts';
import * as React from 'react';

/** 包装成组件，便于复用 renderFacade。 */
function Projects(props: {
  projects: string[];
  wsPath: string;
  sessions: readonly SessionEntry[];
  onNew?: (path: string) => void;
  onReveal?: (path: string) => void;
}): React.ReactElement | null {
  return renderProjectsView(
    props.projects,
    props.wsPath,
    () => {},
    props.sessions,
    props.onNew,
    props.onReveal,
  );
}

/** 最小会话行。 */
function session(id: string, workspace?: string): SessionEntry {
  return {
    id,
    label: id,
    ...(workspace !== undefined ? { workspace } : {}),
  } as SessionEntry;
}

test('项目条显示每个项目的线程数，并标记当前项目', () => {
  const { node } = renderFacade(Projects, {
    props: {
      projects: ['D:\\work\\alpha', 'D:\\work\\beta'],
      wsPath: 'D:\\work\\alpha',
      sessions: [
        session('a1', 'D:\\work\\alpha'),
        session('a2', 'D:\\work\\alpha'),
        session('b1', 'D:\\work\\beta'),
        session('none'),
      ],
    },
  });
  const projects = byClass(node, 'ws-project');
  assert.strictEqual(projects.length, 2);
  const counts = byClass(node, 'ws-project-count').map((n) => allText(n));
  assert.deepEqual(counts, ['2', '1']);
  assert.strictEqual(projects[0]?.props['aria-current'], 'true');
  assert.strictEqual(projects[1]?.props['aria-current'], undefined);
  assert.match(allText(node), /alpha/u);
  assert.match(allText(node), /beta/u);
});

test('无项目时不渲染项目条', () => {
  const { node } = renderFacade(Projects, {
    props: { projects: [], wsPath: '', sessions: [] },
  });
  assert.strictEqual(byClass(node, 'ws-projects').length, 0);
});

test('项目动作：新建线程与打开目录都带项目路径，且不触发切换', () => {
  const calls: string[] = [];
  const { node } = renderFacade(Projects, {
    props: {
      projects: ['D:\\work\\alpha', 'D:\\work\\beta'],
      wsPath: 'D:\\work\\alpha',
      sessions: [],
      onNew: (p: string) => calls.push(`new:${p}`),
      onReveal: (p: string) => calls.push(`reveal:${p}`),
    },
  });
  const actions = byClass(node, 'ws-project-act');
  assert.strictEqual(actions.length, 4);
  for (const action of actions) fireEvent.click(action.el);
  assert.deepStrictEqual(calls, [
    'new:D:\\work\\alpha',
    'reveal:D:\\work\\alpha',
    'new:D:\\work\\beta',
    'reveal:D:\\work\\beta',
  ]);
});
