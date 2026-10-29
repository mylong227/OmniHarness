// 组件挂载契约测试（P5.5）：**真实 React + jsdom** 渲染各组件的 UI 契约。
//
// 迁移（2026-10-18）：原文件用「手写 React 替身 + hook 槽位」驱动 render。真实 React 下：
//   · 「预设 open=true」→ 点真实触发器（`fireEvent.click`）；
//   · 「预设 usage/quota」→ 让组件真的去取（组件接收 `api` prop，直接注入假 api）；
//   · 「预设 elapsed=7」→ 不再依赖槽位；计时初始值即可验证 aria-hidden 契约。
// 断言仍是同一组文案 / aria / class 契约。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderFacade } from './rtlHarness.ts';
import { allText, byTag, facadeOf, walk } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';

const { AddMenu } = await import('../src/ui/components/AddMenu.tsx');
const { PermissionPicker } = await import('../src/ui/components/PermissionPicker.tsx');
const { TreeNode } = await import('../src/ui/components/TreeNode.tsx');
const { PanelPicker } = await import('../src/ui/components/PanelPicker.tsx');
const { Toast } = await import('../src/ui/components/Toast.tsx');
const { WorkIndicator } = await import('../src/ui/components/WorkIndicator.tsx');
const { ApprovalModal } = await import('../src/ui/components/ApprovalModal.tsx');
const { DialogHost } = await import('../src/ui/components/DialogHost.tsx');

/**
 * 深度收集满足谓词的节点。
 * @param node 外观节点（可为 null）
 * @param pred 谓词
 * @returns 命中节点
 */
function collect(node: Facade, pred: (n: FacadeNode) => boolean): FacadeNode[] {
  const out: FacadeNode[] = [];
  walk(node, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

/** 谓词：节点 type 等于给定标签名。 */
const isTag = (name: string) => (n: FacadeNode) => n.type === name;

/**
 * 组件 effect 真的会调用的最小 api 面。
 *
 * 迁移前 effect 从不执行（桩版 useEffect 是占位槽），传 `{}` 也能"过"；真实 React 下
 * 打开菜单/挂载选择器就会真的取数，缺方法会直接 TypeError。这里只实现**断言所依赖的**方法，
 * 返回值按组件既有防御口径给空集合。
 */
const API = {
  async modesGet() {
    return { goal: '', planMode: false, sketchMode: false };
  },
  async listPlugins() {
    return [];
  },
  async agentsList() {
    return { agents: [] };
  },
  async approvalTiers() {
    return { tiers: [] };
  },
};

const ADD_MENU_PROPS = {
  threadId: 't-1',
  api: API,
  onAttach: () => {},
  onToast: () => {},
  onOpenTab: () => {},
  onOpenFile: () => {},
  onLoadThread: () => {},
};

test('AddMenu：初始即闭合态，render 产出根元素且不抛错（免 bootstrap 路径）', () => {
  const vnode = renderFacade(AddMenu, { props: ADD_MENU_PROPS }).node;
  assert.ok(vnode, 'render 必须返回元素树');
  assert.strictEqual(vnode.props['aria-expanded'], 'false', '初始态必须闭合');
  assert.ok(collect(vnode, () => true).length > 0, '元素树非空');
});

test('AddMenu：闭合态渲染触发器（＋）且 aria 契约正确', () => {
  const vnode = renderFacade(AddMenu, { props: ADD_MENU_PROPS }).node;
  assert.strictEqual(allText(vnode), '＋');
  assert.strictEqual(vnode!.props['aria-haspopup'], 'menu');
  assert.strictEqual(vnode!.props['aria-expanded'], 'false');
});

test('AddMenu：打开态 aria-expanded 翻转（UI 状态契约）', async () => {
  const ui = renderFacade(AddMenu, { props: ADD_MENU_PROPS });
  fireEvent.click(ui.node!.el);
  await act(async () => {
    await Promise.resolve();
  });
  const vnode = facadeOf(ui.container.firstElementChild);
  assert.strictEqual(vnode!.props['aria-expanded'], 'true');
});

test('PermissionPicker：档位标签映射 + 说明只走悬浮提示（rules→默认，2026-10-07 用户「不要占地方」）', () => {
  const seen: unknown[] = [];
  const vnode = renderFacade(PermissionPicker, {
    props: {
      permission: 'rules',
      onPick: (v: unknown) => seen.push(v),
      api: API,
    },
  }).node;
  // chip 上只留短档位名（「默认」），完整说明进 title / aria-label：既不占输入区版面，又能悬浮查阅。
  const tip = String(vnode!.props['title']);
  assert.strictEqual(vnode!.props['aria-label'], tip, '悬浮提示与无障碍名必须同源，不得各写一套');
  assert.match(tip, /^AI 权限等级｜默认：/, `悬浮提示必须写明档位名与说明：${tip}`);
  assert.match(tip, /按规则自动放行安全操作/, '说明文字取档位表 description（单一事实源）');
  assert.match(allText(vnode), /默认/);
  assert.doesNotMatch(allText(vnode), /按规则自动放行安全操作/, '长说明不得常驻在 chip 上');
  assert.strictEqual(seen.length, 0, '未交互不触发 onPick');
});

test('PermissionPicker：fullAccess 收起态单层 chip——档位名只出现一次，不套「完全访问」徽标（2026-10-27 用户「不要套两层太占地方」）', () => {
  const vnode = renderFacade(PermissionPicker, {
    props: { permission: 'auto', onPick: () => {}, api: API },
  }).node;
  // 旧实现在这里渲染 label「完全访问」+ 徽标「⚠ 完全访问」两层同文案；现在警示由 danger
  // 配色承担，收起态不得再出现 perm-badge。
  assert.match(String(vnode!.props['className']), /danger/, 'fullAccess 收起态必须带 danger 配色');
  assert.strictEqual(
    (allText(vnode).match(/完全访问/g) ?? []).length,
    1,
    `收起态「完全访问」只允许出现一次（label 本身），不得再套徽标：${allText(vnode)}`,
  );
  assert.strictEqual(
    collect(vnode, (n) => String(n.props['className'] ?? '').includes('perm-badge')).length,
    0,
    '收起态不得渲染 perm-badge 徽标（菜单内的高危档徽标不受此约束）',
  );
});

test('TreeNode：文件树节点渲染名称并保留展开回调（零 DOM 依赖）', () => {
  const vnode = renderFacade(TreeNode, {
    props: {
      node: {
        name: 'src',
        path: 'src',
        kind: 'dir',
        children: [
          { name: 'a.ts', path: 'src/a.ts', kind: 'file' },
          { name: 'b.ts', path: 'src/b.ts', kind: 'file' },
        ],
      },
      onOpenFile: () => {},
    },
  }).node;
  assert.match(allText(vnode), /src/, '节点必须渲染名称');
});

test('PanelPicker：唯一触发器，点击打开面板模态（不再有下拉菜单）', async () => {
  // 2026-10-19：面板选择从下拉菜单改为设置式模态（左导航 + 右内容），这里只钉触发器契约。
  let opened = 0;
  const ui = renderFacade(PanelPicker, {
    props: {
      onOpen: () => {
        opened += 1;
      },
    },
  });
  const btns = byTag(ui.node, 'button');
  assert.strictEqual(btns.length, 1, '只保留 1 个触发按钮');
  assert.strictEqual(btns[0]!.props['aria-haspopup'], 'dialog');
  assert.strictEqual(btns[0]!.props['aria-label'], '全部面板');
  assert.strictEqual(collect(ui.node, (n) => n.props.role === 'menuitem').length, 0, '不得再渲染菜单项');
  fireEvent.click(btns[0]!.el);
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(opened, 1, '点击必须打开面板模态');
});

test('面板注册表：16 项齐全、key 唯一（「全部面板」菜单据此渲染，IA 缺口的机械判据）', async () => {
  // 2026-10-07 壳层重构后，注册表是面板清单的唯一事实源：PanelPicker 菜单渲染 PANELS 全集，
  // Router 的合法 pane 集合与它对齐 ⇒ "任何面板都必须有入口"由本用例机械核对。
  // 2026-10-11：新增 `diagnostics`（Web 交付项：daemon 运行态 + doctor 报告）⇒ 12 → 13，
  // 且**逐条**比对 key 集合（只改数字等于放弃"清单齐全"这半条判据）。
  // 2026-10-17：`settings` 移出（17 → 16）。它不是"看某个东西的状态"的面板，而是"改全局配置"，
  //   现为左栏页脚按钮 + 工作台控制台（components/console/ConsoleModal.tsx）。逐条比对时把它删掉，
  //   并在下方显式断言"注册表里不得再有 settings"——否则它会以"未知 pane"的形式静默落回默认面板。
  const { PANELS, panelOf } = await import('../src/ui/models/PanelRegistry.ts');
  assert.deepStrictEqual(
    PANELS.map((p) => p.key),
    [
      'activity',
      'skills',
      'automations',
      'tools',
      'changes',
      'file',
      'metrics',
      'graph',
      'memory',
      'profiles',
      'governance',
      'rollback',
      'detail',
      'plugins',
      'diagnostics',
      'audit',
      'trace',
      'permission',
      'vault',
    ],
    '注册表必须恰好是这 19 个面板（顺序即菜单渲染顺序）',
  );
  assert.ok(
    panelOf('settings') === undefined,
    'settings 不得再注册为右栏面板：它已改为模态，注册表里留着它会让 openPane("settings") 静默失效',
  );
  const keys = PANELS.map((p) => p.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'key 不得重复');
  for (const p of PANELS) {
    assert.ok(p.label.length > 0 && p.icon.length > 0, `${p.key} 必须同时有标签与图标`);
    assert.ok(panelOf(p.key) === p, `${p.key} 必须能被 panelOf 查到（菜单高亮据此判定）`);
  }
});

test('Toast：role=status + aria-live=polite + aria-atomic（异步提示不打断朗读）', () => {
  const vnode = renderFacade(Toast, {
    props: { toast: { message: '已保存', kind: 'ok', visible: true } },
  }).node;
  assert.strictEqual(vnode!.props.role, 'status');
  assert.strictEqual(vnode!.props['aria-live'], 'polite');
  assert.strictEqual(vnode!.props['aria-atomic'], 'true');
  assert.strictEqual(allText(vnode), '已保存');
});

test('WorkIndicator：role=status 播报动作，跳动计时 aria-hidden 防每秒打断', () => {
  const vnode = renderFacade(WorkIndicator, { props: { activeTool: 'shell' } }).node;
  assert.strictEqual(vnode!.props.role, 'status');
  assert.strictEqual(vnode!.props['aria-live'], 'polite');
  const hidden = collect(vnode, (n) => n.props['aria-hidden'] === 'true');
  assert.strictEqual(hidden.length, 2, '圆点与计时数字都应 aria-hidden');
  assert.match(allText(vnode), /正在执行命令/);
});

test('ApprovalModal：role=dialog + aria-modal + labelledby/describedby 且锚点存在', () => {
  const vnode = renderFacade(ApprovalModal, {
    props: {
      approval: { requestId: 'r1', toolName: 'shell', target: 'rm -rf /', args: { cmd: 'rm -rf /' } },
      onRespond: () => {},
    },
  }).node;
  const dialogs = collect(vnode, (n) => n.props.role === 'dialog');
  assert.strictEqual(dialogs.length, 1, '必须产出唯一 role=dialog 的模态框');
  assert.strictEqual(dialogs[0]!.props['aria-modal'], 'true');
  assert.strictEqual(dialogs[0]!.props['aria-labelledby'], 'ap-title');
  assert.strictEqual(dialogs[0]!.props['aria-describedby'], 'ap-desc');
  assert.strictEqual(collect(vnode, (n) => n.props.id === 'ap-title').length, 1, 'labelledby 必须指向存在的元素');
  assert.strictEqual(collect(vnode, (n) => n.props.id === 'ap-desc').length, 1, 'describedby 必须指向存在的元素');

  const idle = renderFacade(ApprovalModal, { props: { approval: null, onRespond: () => {} } }).node;
  assert.strictEqual(collect(idle, (n) => n.props.role === 'dialog').length, 0, '无请求时不得留可聚焦的对话框');
});

test('DialogHost：confirm 无输入框、prompt 有输入框，两者都有完整 dialog 语义', () => {
  const hidden = renderFacade(DialogHost, { props: { dialog: { request: null } } }).node;
  assert.strictEqual(collect(hidden, (n) => n.props.role === 'dialog').length, 0);

  const base = {
    kind: 'confirm',
    title: '丢弃改动',
    message: '此操作不可恢复',
    confirmLabel: '丢弃',
    cancelLabel: '取消',
    placeholder: '',
    danger: true,
    initial: '',
  };
  const vnode = renderFacade(DialogHost, {
    props: { dialog: { request: { ...base } } },
  }).node;
  const dialogs = collect(vnode, (n) => n.props.role === 'dialog');
  assert.strictEqual(dialogs.length, 1);
  assert.strictEqual(dialogs[0]!.props['aria-modal'], 'true');
  assert.strictEqual(dialogs[0]!.props['aria-labelledby'], 'dlg-title');
  assert.strictEqual(dialogs[0]!.props['aria-describedby'], 'dlg-body');
  assert.strictEqual(collect(vnode, isTag('input')).length, 0, 'confirm 不该渲染输入框');
  assert.match(allText(vnode), /不可恢复/);

  // prompt：input 的初值来自 request.initial（真实 effect 同步进 state）。
  const promptVnode = renderFacade(DialogHost, {
    props: { dialog: { request: { ...base, kind: 'prompt', initial: '旧目标', placeholder: '例如' } } },
  }).node;
  const inputs = collect(promptVnode, isTag('input'));
  assert.strictEqual(inputs.length, 1, 'prompt 必须渲染输入框');
  assert.strictEqual(inputs[0]!.props.value, '旧目标');
  assert.strictEqual(inputs[0]!.props['aria-label'], '丢弃改动');
});

test('StreamView 契约：事件流容器是 role=log + aria-live=polite 的播报区', async () => {
  const { StreamView } = await import('../src/ui/components/StreamView.tsx');
  const vnode = renderFacade(StreamView, {
    props: {
      events: [],
      toolResults: {},
      liveInputs: [],
      onEventClick: () => {},
      onSend: () => {},
      model: '',
      reasoning: '',
      permission: '',
      api: API,
      onModelChange: () => {},
      onReasoningChange: () => {},
      onPermissionChange: () => {},
    },
  }).node;
  const logs = collect(vnode, (n) => n.props.role === 'log');
  assert.strictEqual(logs.length, 1, '中栏事件流必须是唯一 role=log 播报区');
  assert.strictEqual(logs[0]!.props['aria-live'], 'polite');
  assert.strictEqual(logs[0]!.props['aria-label'], '对话事件流');
});
