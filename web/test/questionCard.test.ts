// 提问卡（QuestionCard）的交互契约测试：这是「用户到底能不能提交作答」的唯一判据面。
//
// 背景（2026-10-08 用户报障）：Web 端此前的提问只有只读卡（选项恒 disabled、无提交入口），
// 用户看得见问题却答不了。本测试钉住三件事：
//   ① 卡片结构：逐题给选项控件 + 自由输入 + 提交/跳过；
//   ② 提交门禁：未逐题作答时提交禁用（半空白作答会让模型瞎猜）；
//   ③ 提交载荷：恰好是服务端 `question.respond` 要的 `{ id, selected, custom }` 同序数组。
//
// 迁移（2026-10-18）：旧用例手工递归展开函数组件节点 + 直接调 props.onClick/onChange。
// 真实 React + jsdom 下改成**真实点击 / 真实输入**（`fireEvent.click` + `userEvent.type`），
// aria 断言按 DOM 语义取字符串（`aria-checked` 是 `'true'/'false'`）。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, renderFacade, waitFor } from './rtlHarness.ts';
import { allText, byClass, facadeOf } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';

const { QuestionCard } = await import('../src/ui/components/QuestionCard.tsx');

/** 两题样本：q1 单选、q2 多选。 */
const REQUEST = {
  requestId: 'qst_test_1',
  sessionId: 's1',
  questions: [
    {
      id: 'q1',
      header: '确认范围',
      question: '这次做哪一种？',
      options: [{ label: 'A', description: '说明 A' }, { label: 'B' }],
    },
    {
      id: 'q2',
      question: '还想要什么？',
      multiSelect: true,
      options: [{ label: 'X' }, { label: 'Y' }],
    },
  ],
  timeoutMs: 0,
};

/** 取 className（class 词匹配用）。 */
function clsOf(n: FacadeNode): string {
  const v = n.props['className'];
  return typeof v === 'string' ? v : '';
}

/**
 * 按 className 取节点（**按 class 词匹配**，故 `qask-option is-checked` 也能被 `qask-option` 命中）。
 * @param tree 外观节点
 * @param className 目标 class 词
 * @returns 命中的节点数组（文档序）
 */
function nodesByClass(tree: Facade, className: string): FacadeNode[] {
  return byClass(tree, className);
}

/** 取「提交回答」按钮。 */
function submitButton(tree: Facade): FacadeNode | undefined {
  return byClass(tree, 'qask-submit')[0];
}

/**
 * 渲染一次提问卡。
 * @param props 组件属性（缺省为一个只会记录调用的 onSubmit）
 * @returns 渲染句柄与重取节点函数
 */
function render(props: Record<string, unknown> = {}) {
  const ui = renderFacade(QuestionCard, {
    props: { request: REQUEST, onSubmit: async () => {}, onExpire: () => {}, ...props },
  });
  return { ...ui, tree: (): Facade => facadeOf(ui.container.firstElementChild) };
}

test('提问卡：逐题渲染选项控件、自由输入、进度与提交/跳过', () => {
  const { node } = render();
  assert.strictEqual(clsOf(node!), 'qask');
  assert.strictEqual(nodesByClass(node, 'qask-item').length, 2, '两题都要渲染');
  assert.strictEqual(nodesByClass(node, 'qask-eyebrow').length, 1, '只有带 header 的那题有短标题');
  // 选项是可聚焦控件（不是只读内容）：role + aria-checked 齐备，供读屏与键盘使用
  const options = nodesByClass(node, 'qask-option');
  assert.strictEqual(options.length, 4);
  for (const option of options) {
    assert.strictEqual(option.type, 'button');
    assert.ok(option.props.role === 'radio' || option.props.role === 'checkbox');
    assert.strictEqual(option.props['aria-checked'], 'false');
  }
  assert.strictEqual(nodesByClass(node, 'qask-custom').length, 2, '每题都要能补充自由输入');
  const submit = submitButton(node)!;
  assert.strictEqual(submit.props.disabled, true, '一题都没答时不得提交');
  assert.strictEqual(nodesByClass(node, 'qask-skip').length, 1, '必须保留「全部跳过」这个显式出口');
});

test('提问卡：勾选后进度与提交门禁随作答推进，提交载荷与提问同序', async () => {
  const submitted: unknown[] = [];
  const onSubmit = async (answers: unknown) => {
    submitted.push(answers);
  };
  const { node, tree } = render({ onSubmit });
  assert.match(allText(nodesByClass(node, 'qask-progress')[0]!), /已作答 0\/2/);

  // 第一题选 A（单选）。每次点击都重渲染，必须从同一容器重新取树。
  fireEvent.click(nodesByClass(tree(), 'qask-option')[0]!.el);
  assert.strictEqual(
    nodesByClass(tree(), 'qask-option')[0]!.props['aria-checked'],
    'true',
    '选中态必须反映到 aria-checked',
  );
  assert.strictEqual(submitButton(tree())!.props.disabled, true, '还有一题没答，仍不可提交');
  assert.match(allText(nodesByClass(tree(), 'qask-progress')[0]!), /已作答 1\/2/);

  // 第二题多选 X + Y。
  fireEvent.click(nodesByClass(tree(), 'qask-option')[2]!.el);
  assert.strictEqual(nodesByClass(tree(), 'qask-option')[2]!.props['aria-checked'], 'true');
  fireEvent.click(nodesByClass(tree(), 'qask-option')[3]!.el);
  assert.strictEqual(nodesByClass(tree(), 'qask-option')[3]!.props['aria-checked'], 'true');
  assert.strictEqual(
    submitButton(tree())!.props.disabled,
    undefined,
    '逐题作答后必须可以提交（DOM 里无 disabled 属性）',
  );

  fireEvent.click(submitButton(tree())!.el);
  await waitFor(() => {
    if (submitted.length !== 1) throw new Error('提交尚未完成');
  });
  assert.deepStrictEqual(submitted, [
    [
      { id: 'q1', selected: ['A'], custom: '' },
      { id: 'q2', selected: ['X', 'Y'], custom: '' },
    ],
  ]);
});

test('提问卡：自由输入可独立作答（无选项的题），「全部跳过」提交空选择', async () => {
  const submitted: unknown[] = [];
  const freeText = {
    requestId: 'qst_test_2',
    questions: [{ id: 'why', header: '补充', question: '你想要什么形态的产出？' }],
  };
  const ui = renderFacade(QuestionCard, {
    props: {
      request: freeText,
      onSubmit: async (answers: unknown) => {
        submitted.push(answers);
      },
      onExpire: () => {},
    },
  });
  const tree = (): Facade => facadeOf(ui.container.firstElementChild);
  assert.strictEqual(nodesByClass(tree(), 'qask-options').length, 0, '无选项的题不渲染选项组');
  const input = nodesByClass(tree(), 'qask-custom')[0]!;
  assert.strictEqual(input.props.placeholder, '输入你的回答');
  const user = userEvent.setup();
  await user.type(input.el as HTMLElement, '  只要一份报告  ');
  assert.strictEqual(
    submitButton(tree())!.props.disabled,
    undefined,
    '自由输入非空即算已作答',
  );

  fireEvent.click(submitButton(tree())!.el);
  await waitFor(() => {
    if (submitted.length !== 1) throw new Error('提交尚未完成');
  });
  assert.deepStrictEqual(submitted, [[{ id: 'why', selected: [], custom: '只要一份报告' }]]);

  fireEvent.click(nodesByClass(tree(), 'qask-skip')[0]!.el);
  await waitFor(() => {
    if (submitted.length !== 2) throw new Error('跳过尚未提交');
  });
  assert.deepStrictEqual(submitted[1], [{ id: 'why', selected: [] }], '跳过必须提交空选择（而不是不提交）');
});

test('提问卡：单选组是单一 Tab 落点，方向键/Home/End 环绕并选中（WAI-ARIA 单选组模式）', () => {
  // 2026-10-29（W3）：选项是 `role="radio"` 的 button，此前**每个都能 Tab 进去、方向键无效**，
  // 不符合 APG 的单选组模式。现在单选组只有「选中项（都没选时第一项）」在 Tab 序列里，
  // ←/→/↑/↓ 环绕移动并选中，Home/End 到首尾；多选组保持每项独立 Tab 落点。
  const { tree } = render();
  const opts = () => nodesByClass(tree(), 'qask-option');
  assert.strictEqual(opts()[0]!.props.tabIndex, '0', '都没选时第一项是唯一 Tab 落点');
  assert.strictEqual(opts()[1]!.props.tabIndex, '-1', '其余单选项退出 Tab 序列');
  assert.strictEqual(opts()[2]!.props.tabIndex, '0', '多选组每项都可 Tab（不参与 roving）');
  assert.strictEqual(opts()[3]!.props.tabIndex, '0');

  fireEvent.keyDown(opts()[0]!.el, { key: 'ArrowDown' });
  assert.strictEqual(opts()[1]!.props['aria-checked'], 'true', '方向键必须选中下一项');
  assert.strictEqual(opts()[1]!.props.tabIndex, '0');
  assert.strictEqual(opts()[0]!.props.tabIndex, '-1');
  assert.strictEqual(document.activeElement, opts()[1]!.el, '焦点必须跟着走');

  fireEvent.keyDown(opts()[1]!.el, { key: 'ArrowDown' });
  assert.strictEqual(opts()[0]!.props['aria-checked'], 'true', '末项向下必须环绕到首项');
  fireEvent.keyDown(opts()[0]!.el, { key: 'End' });
  assert.strictEqual(opts()[1]!.props['aria-checked'], 'true', 'End 必须到末项');
  fireEvent.keyDown(opts()[1]!.el, { key: 'Home' });
  assert.strictEqual(opts()[0]!.props['aria-checked'], 'true', 'Home 必须回首项');
});
