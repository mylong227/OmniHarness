// 判据：ui/kit 骨架（W1）。kit 是业务组件消费 antd 的唯一封装层，
// 契约：① 真实渲染（真 React + jsdom）；② testId 透传成 data-testid；③ 文案/语义正确。

// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import * as React from 'react';
import { ThemeProvider } from '../src/ui/theme/ThemeProvider.tsx';
import { PageHeader } from '../src/ui/kit/PageHeader.tsx';
import { PanelSection } from '../src/ui/kit/PanelSection.tsx';
import { StatusTag } from '../src/ui/kit/StatusTag.tsx';
import { EmptyState } from '../src/ui/kit/EmptyState.tsx';

afterEach(cleanup);

/** 统一包裹：kit 组件默认假定处于 ThemeProvider 之下（与 App 装配一致）。 */
function ui(node: React.ReactElement): React.ReactElement {
  return React.createElement(ThemeProvider, { theme: 'dark' }, node);
}

test('PageHeader：标题/说明/动作 + testId 透传', () => {
  render(
    ui(
      React.createElement(PageHeader, {
        title: '上下文容量',
        description: '大条分母是窗口、行百分比分母是已用上下文',
        actions: React.createElement('button', { type: 'button' }, '刷新'),
        testId: 'capacity-header',
      }),
    ),
  );
  assert.ok(screen.getByTestId('capacity-header'));
  assert.ok(screen.getByText('上下文容量'));
  assert.ok(screen.getByText(/大条分母是窗口/));
  assert.ok(screen.getByText('刷新'));
  cleanup();

  // 无说明/无动作时不渲染空占位。
  render(
    ui(React.createElement(PageHeader, { title: '只有标题', testId: 'bare-header' })),
  );
  assert.ok(screen.getByTestId('bare-header'));
  assert.ok(screen.getByText('只有标题'));
});

test('PanelSection：标题 + 说明 + 内容结构', () => {
  render(
    ui(
      React.createElement(
        PanelSection,
        { title: '上下文构成', description: '两种口径不再混用', testId: 'cap-card' },
        React.createElement('p', null, '正文内容'),
      ),
    ),
  );
  assert.ok(screen.getByTestId('cap-card'));
  assert.ok(screen.getByText('上下文构成'));
  assert.ok(screen.getByText('两种口径不再混用'));
  assert.ok(screen.getByText('正文内容'));
});

test('StatusTag：五种语义全部可渲染', () => {
  for (const status of ['ok', 'warn', 'err', 'info', 'neutral'] as const) {
    render(
      ui(
        React.createElement(StatusTag, { status, testId: `tag-${status}` }, status),
      ),
    );
    assert.ok(screen.getByTestId(`tag-${status}`));
    assert.ok(screen.getByText(status));
    cleanup();
  }
});

test('EmptyState：标题 + 提示 + 动作', () => {
  render(
    ui(
      React.createElement(EmptyState, {
        title: '还没有会话',
        hint: '点「新会话」开始',
        action: React.createElement('button', { type: 'button' }, '新会话'),
        testId: 'empty-sessions',
      }),
    ),
  );
  assert.ok(screen.getByTestId('empty-sessions'));
  assert.ok(screen.getByText('还没有会话'));
  assert.ok(screen.getByText(/点「新会话」开始/));
  assert.ok(screen.getByText('新会话'));
});
