// 提问卡（QuestionCard）的交互契约测试：这是「用户到底能不能提交作答」的唯一判据面。
//
// 背景（2026-10-08 用户报障）：Web 端此前的提问只有只读卡（选项恒 disabled、无提交入口），
// 用户看得见问题却答不了。本测试钉住三件事：
//   ① 卡片结构：逐题给选项控件 + 自由输入 + 提交/跳过；
//   ② 提交门禁：未逐题作答时提交禁用（半空白作答会让模型瞎猜）；
//   ③ 提交载荷：恰好是服务端 `question.respond` 要的 `{ id, selected, custom }` 同序数组。
//
// 手法与 mount.test.mjs 一致：零 DOM 桩 + hooksStub 的 hook 槽位运行时，不加载真实 React。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { QuestionCard } = await import('../dist/ui/components/QuestionCard.js');

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

/**
 * 递归展开函数组件节点（零 DOM 环境里 createElement 不会实例化子组件）。
 * @param vnode 节点
 * @returns 展开后的节点树
 */
function expand(vnode) {
  if (vnode == null || typeof vnode !== 'object') return vnode;
  if (typeof vnode.type === 'function') return expand(vnode.type(vnode.props));
  return { ...vnode, children: (vnode.children ?? []).flat(Infinity).map(expand) };
}

/** 深度收集元素节点。 */
function walk(vnode) {
  if (vnode == null || typeof vnode !== 'object') return [];
  return [vnode, ...(vnode.children ?? []).flat(Infinity).flatMap(walk)];
}

/** 取节点的 className。 */
function clsOf(vnode) {
  return typeof vnode?.props?.className === 'string' ? vnode.props.className : '';
}

/**
 * 渲染一次提问卡。
 * @param props 组件属性（缺省为一个只会记录调用的 onSubmit）
 * @returns 展开后的节点树
 */
function render(props = {}) {
  return expand(runtime.render(QuestionCard, { request: REQUEST, onSubmit: async () => {}, onExpire: () => {}, ...props }));
}

/**
 * 按 className 取节点（**按 class 词匹配**，故 `qask-option is-checked` 也能被 `qask-option` 命中）。
 * @param tree 节点树
 * @param className 目标 class 词
 * @returns 命中的节点数组（文档序）
 */
function byClass(tree, className) {
  return walk(tree).filter((n) => clsOf(n).split(' ').includes(className));
}

/** 取「提交回答」按钮。 */
function submitButton(tree) {
  return walk(tree).find((n) => clsOf(n) === 'qask-submit');
}

test('提问卡：逐题渲染选项控件、自由输入、进度与提交/跳过', () => {
  const tree = render();
  assert.equal(clsOf(tree), 'qask');
  assert.equal(byClass(tree, 'qask-item').length, 2, '两题都要渲染');
  assert.equal(byClass(tree, 'qask-eyebrow').length, 1, '只有带 header 的那题有短标题');
  // 选项是可聚焦控件（不是只读内容）：role + aria-checked 齐备，供读屏与键盘使用
  const options = byClass(tree, 'qask-option');
  assert.equal(options.length, 4);
  for (const option of options) {
    assert.equal(option.type, 'button');
    assert.ok(option.props.role === 'radio' || option.props.role === 'checkbox');
    assert.equal(option.props['aria-checked'], false);
  }
  assert.equal(byClass(tree, 'qask-custom').length, 2, '每题都要能补充自由输入');
  const submit = submitButton(tree);
  assert.equal(submit.props.disabled, true, '一题都没答时不得提交');
  assert.equal(byClass(tree, 'qask-skip').length, 1, '必须保留「全部跳过」这个显式出口');
});

test('提问卡：勾选后进度与提交门禁随作答推进，提交载荷与提问同序', async () => {
  const submitted = [];
  const onSubmit = async (answers) => {
    submitted.push(answers);
  };
  // 首屏（未作答）
  let tree = render({ onSubmit });
  assert.match(
    walk(tree).find((n) => clsOf(n) === 'qask-progress').children.flat(Infinity).join(''),
    /已作答 0\/2/,
  );
  // 第一题选 A
  const q1Options = byClass(tree, 'qask-option').slice(0, 2);
  q1Options[0].props.onClick();
  tree = render({ onSubmit });
  assert.equal(byClass(tree, 'qask-option')[0].props['aria-checked'], true, '选中态必须反映到 aria-checked');
  assert.equal(submitButton(tree).props.disabled, true, '还有一题没答，仍不可提交');
  assert.match(
    walk(tree).find((n) => clsOf(n) === 'qask-progress').children.flat(Infinity).join(''),
    /已作答 1\/2/,
  );
  // 第二题多选 X + Y
  const q2Options = byClass(tree, 'qask-option').slice(2);
  q2Options[0].props.onClick();
  tree = render({ onSubmit });
  q2Options[1].props.onClick();
  tree = render({ onSubmit });
  assert.equal(byClass(tree, 'qask-option')[2].props['aria-checked'], true);
  assert.equal(byClass(tree, 'qask-option')[3].props['aria-checked'], true);
  assert.equal(submitButton(tree).props.disabled, false, '逐题作答后必须可以提交');
  // 提交
  submitButton(tree).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(submitted, [
    [
      { id: 'q1', selected: ['A'], custom: '' },
      { id: 'q2', selected: ['X', 'Y'], custom: '' },
    ],
  ]);
});

test('提问卡：自由输入可独立作答（无选项的题），「全部跳过」提交空选择', async () => {
  const submitted = [];
  const freeText = {
    requestId: 'qst_test_2',
    questions: [{ id: 'why', header: '补充', question: '你想要什么形态的产出？' }],
  };
  const tree = expand(
    runtime.render(QuestionCard, {
      request: freeText,
      onSubmit: async (answers) => {
        submitted.push(answers);
      },
      onExpire: () => {},
    }),
  );
  assert.equal(byClass(tree, 'qask-options').length, 0, '无选项的题不渲染选项组');
  const input = byClass(tree, 'qask-custom')[0];
  assert.equal(input.props.placeholder, '输入你的回答');
  input.props.onChange({ target: { value: '  只要一份报告  ' } });
  const again = expand(
    runtime.render(QuestionCard, {
      request: freeText,
      onSubmit: async (answers) => {
        submitted.push(answers);
      },
      onExpire: () => {},
    }),
  );
  assert.equal(submitButton(again).props.disabled, false, '自由输入非空即算已作答');
  submitButton(again).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(submitted, [[{ id: 'why', selected: [], custom: '只要一份报告' }]]);
  byClass(again, 'qask-skip')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(submitted[1], [{ id: 'why', selected: [] }], '跳过必须提交空选择（而不是不提交）');
});
