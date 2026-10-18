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

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync } from './rtlHarness.ts';
import { allText, byTag, clsOf, facadeOf, walk } from './domFacade.ts';
import type { FacadeNode } from './domFacade.ts';

const { GovernanceTab } = await import('../src/ui/components/tabs/GovernanceTab.tsx');
const { RightPanel } = await import('../src/ui/components/RightPanel.tsx');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 深度收集满足谓词的节点。
 * @param node 外观节点
 * @param pred 谓词
 * @returns 命中节点
 */
function collect(node: FacadeNode | null, pred: (n: FacadeNode) => boolean): FacadeNode[] {
  const out: FacadeNode[] = [];
  walk(node, (n) => {
    if (pred(n)) out.push(n);
  });
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

/**
 * 渲染治理面板并等一次 `governance.history` 取数落地。
 *
 * 迁移说明（2026-10-18）：旧写法用 hook 槽位直接摆"已取到的数据"。真实 React 下改成
 * **让组件真的去取**——槽位 0 变成 `api.rpc('governance.history')` 的返回值，槽位 1（错误）
 * 变成一次抛错，于是判据不但复现同一场景，还顺带覆盖了真实取数/错误路径。
 *
 * @param response `governance.history` 的返回体，或一个抛错的实现
 * @returns 外观节点
 */
async function renderSeeded(response: unknown) {
  const ui = await renderFacadeAsync(GovernanceTab, { props: {}, responses: { rpc: response } });
  return ui.node;
}

test('F2 面板：逐行复核可见（✓/✗ 与原因）+ 汇总 + 回滚锚点，且不提供"点一下就回滚"', async () => {
  const tree = await renderSeeded(viewWithOneFailure());

  const text = allText(tree);
  assert.match(text, /独立复核通过 1 \/ 2/, '必须给出逐行复核汇总');
  assert.match(text, /首个失败 #2/);
  assert.match(text, /#1/);
  assert.match(text, /#2/);
  assert.match(text, /第 2 条自算哈希与记录不符/, '坏行必须直接显示原因');

  // 坏行带 err 类（视觉上显眼）。
  const rowNodes = collect(
    tree,
    (node) => clsOf(node).startsWith('row'),
  );
  assert.ok(rowNodes.length >= 3, `必须渲染出表头与逐行条目，实际 ${String(rowNodes.length)}`);
  assert.ok(
    rowNodes.some((row) => clsOf(row).includes('err')),
    '坏行必须带 err 类',
  );

  // 回滚锚点可见 + 提示走命令行（面板不提供执行按钮）。
  assert.match(text, /可回滚快照/);
  assert.match(text, /#1（2 技能/);
  assert.match(text, /evolution rollback --seq/);
  // DOM 语义：外观节点不搬事件处理器（见 domFacade 的边界），改用真实 button 元素计数。
  const buttons = byTag(tree, 'button');
  assert.strictEqual(buttons.length, 1, '面板只应有"刷新"一个按钮（不得提供"点一下就回滚"）');
  assert.match(allText(buttons[0]!), /刷新/);
});

test('F2 面板：台账读不出来 ⇒ 显示原因（**不是**空列表）', async () => {
  const tree = await renderSeeded({
    available: false,
    reason: '晋升台账不可用（/tmp/x）：EACCES',
  });
  const text = allText(tree);
  assert.match(text, /晋升台账不可用/, '必须直说读不出来');
  assert.ok(!/暂无治理数据/.test(text), '不得退化成"暂无数据"（那会被误读成没有晋升记录）');
});

test('F2 面板：rpc 抛错 ⇒ 可读错误 + 重试按钮（不整页白屏）', async () => {
  const tree = await renderSeeded(() => {
    throw new Error('boom');
  });
  const text = allText(tree);
  assert.match(text, /读取治理数据失败：boom/);
  const retry = byTag(tree, 'button');
  assert.ok(retry.length >= 1, '必须给出重试入口');
});

test('F2 注册：激活 governance 时 RightPanel 出现其标签，Router 认可该 pane', async () => {
  // 2026-10-07 壳层重构：右栏标签条不再常驻 12 个面板（收进 PanelPicker 菜单），
  // 但激活某面板时它必须以标签形式出现——这里钉住「治理激活 ⇒ 有治理标签」这条契约。
  const ui = await renderFacadeAsync(RightPanel, {
    props: { activePane: 'governance', onSelect: () => {}, open: true },
  });
  const tabs = collect(ui.node, (node) => node.props.role === 'tab');
  assert.ok(
    tabs.some((tab) => tab.props.id === 'tab-pane-governance'),
    '激活治理面板时 RightPanel 必须渲染其标签（漏注册则永远选不中）',
  );
  // 全部面板仍可一步到达：点开标签条右端的「全部面板」菜单，注册表里的 12 项必须都在。
  // （迁移前按组件类型 `PanelPicker` 断言存在性；真实 React 会把子组件渲染成 DOM，
  // 这里改成**点击后逐项可见**——比只断言"组件挂上了"更强。）
  const trigger = byTag(ui.node, 'button').find(
    (btn) => btn.props['aria-label'] === '全部面板',
  );
  assert.ok(trigger !== undefined, '右栏必须常驻「全部面板」入口');
  fireEvent.click(trigger.el);
  const menu = facadeOf(ui.container.firstElementChild);
  const items = collect(menu, (node) => node.props.role === 'menuitem');
  assert.ok(items.length >= 12, `全部面板菜单必须列出注册表条目，实际 ${String(items.length)}`);
  assert.ok(
    items.some((item) => allText(item) === '治理'),
    '治理面板必须可从「全部面板」一步到达',
  );

  const route = parseHash.call(null);
  assert.strictEqual(typeof route, 'object', 'parseHash 可用');
  // `#pane=governance` 必须被认作合法 pane（否则静默落回默认面板）。
  const original = globalThis.location;
  // 桩只提供 parseHash 实际读取的 hash 字段（按边界约定断言为 Location）。
  globalThis.location = { hash: '#pane=governance' } as Location;
  try {
    assert.strictEqual(parseHash().pane, 'governance');
  } finally {
    globalThis.location = original;
  }
});
