/**
 * F2 治理台面板判据（`GovernanceTab` + 面板注册）。
 *
 * ## 判据要钉死什么
 *
 * 1. **逐行复核可见**：正常视图 ⇒ 每行显示 ✓ 与 `#seq`，汇总给出 `通过 N/M`；
 * 2. **坏行必须显眼**：`verified:false` 的行带 `err` 类并**直接显示原因**
 *    （不许只给一个 ✗ 让人自己找原因）；
 * 3. **台账读不出来就直说**：`available:false` ⇒ 显示原因，**不显示空列表**
 *    （空列表会被误读成"没有晋升记录"）；
 * 4. **回滚是显式动作**：只列快照锚点 + 提示命令行入口，面板本身**不**提供"点一下就回滚"；
 * 5. **面板已注册**：`RightPanel` 的 tab 列表含 `governance`，且 `Router` 认可该 pane
 *    （漏注册会让 `#pane=governance` 静默落回默认面板）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { GovernanceTab } = await import('../dist/ui/components/tabs/GovernanceTab.js');
const { RightPanel } = await import('../dist/ui/components/RightPanel.js');
const { parseHash } = await import('../dist/core/Router.js');

let lastRendered = null;

/**
 * 渲染一次组件（函数组件：换组件即清槽位）。
 * @param Component 组件函数
 * @param props 组件属性
 * @param seed hook 槽位预设值
 * @returns vnode 树
 */
function renderOf(Component, props, seed) {
  if (Component !== lastRendered) {
    runtime.reset();
    lastRendered = Component;
  }
  return runtime.render(Component, props, seed);
}

/**
 * 深度收集满足谓词的节点。
 * @param vnode vnode 树
 * @param pred 谓词
 * @param out 收集器
 * @returns 命中节点
 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const node of vnode) collect(node, pred, out);
    return out;
  }
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

/**
 * 收集整棵树的文本叶子（无缝拼接）。
 * @param vnode vnode 树
 * @param out 收集器
 * @returns 文本片段
 */
function texts(vnode, out = []) {
  if (Array.isArray(vnode)) {
    for (const node of vnode) texts(node, out);
    return out;
  }
  if (vnode === null || vnode === undefined) return out;
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    out.push(String(vnode));
    return out;
  }
  texts(vnode.children, out);
  return out;
}

/**
 * 造一份治理视图（一行正常 + 一行坏）。
 * @returns 服务端返回形状
 */
function viewWithOneFailure() {
  return {
    available: true,
    view: {
      rows: [
        {
          seq: 1,
          ts: '2026-10-04T00:00:00.000Z',
          action: 'snapshot',
          hash: 'a'.repeat(64),
          prev: '0'.repeat(64),
          verified: true,
        },
        {
          seq: 2,
          ts: '2026-10-04T00:00:00.000Z',
          action: 'promote',
          name: 'c',
          source: 'twist:a+b',
          hash: 'b'.repeat(64),
          prev: 'a'.repeat(64),
          verified: false,
          reason: '第 2 条自算哈希与记录不符（正文被改）',
        },
      ],
      summary: { total: 2, verified: 1, firstFailureSeq: 2 },
      rollbackTargets: [{ seq: 1, ts: '2026-10-04T00:00:00.000Z', skillCount: 2 }],
    },
  };
}

test('F2 面板：逐行复核可见（✓/✗ 与原因）+ 汇总 + 回滚锚点，且不提供"点一下就回滚"', () => {
  // 桩版 `useEffect` 是占位槽（零 DOM 环境无真实提交阶段），故用**槽位预设**驱动渲染后状态：
  // 槽位 0 = data、1 = error、2 = loading（组件内三个 useState 的调用序）。
  const tree = renderOf(GovernanceTab, {}, { 0: viewWithOneFailure(), 1: null, 2: false });

  const text = texts(tree).join('');
  assert.match(text, /独立复核通过 1 \/ 2/, '必须给出逐行复核汇总');
  assert.match(text, /首个失败 #2/);
  assert.match(text, /#1/);
  assert.match(text, /#2/);
  assert.match(text, /第 2 条自算哈希与记录不符/, '坏行必须直接显示原因');

  // 坏行带 err 类（视觉上显眼）。
  const rowNodes = collect(
    tree,
    (node) => typeof node.props.className === 'string' && node.props.className.startsWith('row'),
  );
  assert.ok(rowNodes.length >= 3, `必须渲染出表头与逐行条目，实际 ${String(rowNodes.length)}`);
  assert.ok(
    rowNodes.some((row) => row.props.className.includes('err')),
    '坏行必须带 err 类',
  );

  // 回滚锚点可见 + 提示走命令行（面板不提供执行按钮）。
  assert.match(text, /可回滚快照/);
  assert.match(text, /#1（2 技能/);
  assert.match(text, /evolution rollback --seq/);
  const buttons = collect(tree, (node) => typeof node.props.onClick === 'function');
  assert.strictEqual(buttons.length, 1, '面板只应有"刷新"一个按钮（不得提供"点一下就回滚"）');
  assert.match(texts(buttons[0]).join(''), /刷新/);
});

test('F2 面板：台账读不出来 ⇒ 显示原因（**不是**空列表）', () => {
  const tree = renderOf(GovernanceTab, {}, {
    0: { available: false, reason: '晋升台账不可用（/tmp/x）：EACCES' },
    1: null,
    2: false,
  });
  const text = texts(tree).join('');
  assert.match(text, /晋升台账不可用/, '必须直说读不出来');
  assert.ok(!/暂无治理数据/.test(text), '不得退化成"暂无数据"（那会被误读成没有晋升记录）');
});

test('F2 面板：rpc 抛错 ⇒ 可读错误 + 重试按钮（不整页白屏）', () => {
  const tree = renderOf(GovernanceTab, {}, { 0: null, 1: 'boom', 2: false });
  const text = texts(tree).join('');
  assert.match(text, /读取治理数据失败：boom/);
  const retry = collect(tree, (node) => typeof node.props.onClick === 'function');
  assert.ok(retry.length >= 1, '必须给出重试入口');
});

test('F2 注册：RightPanel 的 tab 列表含 governance，Router 认可该 pane', () => {
  const panel = renderOf(RightPanel, { activePane: 'governance', onSelect: () => {}, open: true });
  const tabs = collect(panel, (node) => node.props.role === 'tab');
  assert.ok(
    tabs.some((tab) => tab.props.id === 'tab-governance'),
    'RightPanel 必须注册治理面板（漏注册则该 tab 永远选不中）',
  );
  assert.ok(tabs.length >= 12, `面板数量应随治理台增至 12，实际 ${String(tabs.length)}`);
  const route = parseHash.call(null);
  assert.strictEqual(typeof route, 'object', 'parseHash 可用');
  // `#pane=governance` 必须被认作合法 pane（否则静默落回默认面板）。
  const original = globalThis.location;
  globalThis.location = { hash: '#pane=governance' };
  try {
    assert.strictEqual(parseHash().pane, 'governance');
  } finally {
    globalThis.location = original;
  }
});
