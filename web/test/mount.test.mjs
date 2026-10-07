// 组件挂载契约测试（P5.5）：无第三方依赖 DOM 桩——不加载真实 React/ReactDOM，
// 用「预置 window 桩 + createElement 收集」驱动 class 组件的 render()，对元素树做断言。
// 覆盖面：组件可实例化、render 产出合法 vnode 树、关键 UI 契约（文案/回调接线）不变。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

// deps.js 在模块顶层读 window；先种桩再动态 import 编译产物。
// 运行时同时支持两种形态：函数组件（直接调用 + hook 槽位）与过渡期的 class 组件（new + render）。
const runtime = createRuntime();
runtime.install();

/**
 * 渲染组件一次（兼容函数组件与 class 组件）。
 * @param Component 组件函数或 class
 * @param props 组件属性
 * @param statePatch class：浅合并进实例 state；函数组件：按 hook 序号预设值
 * @returns vnode 树
 */
let lastRendered = null;
function renderOf(Component, props, statePatch) {
  const isClass = typeof Component === 'function' && Component.prototype && Component.prototype.render;
  if (isClass) {
    const inst = new Component(props);
    if (statePatch && typeof statePatch === 'object' && !Array.isArray(statePatch)) {
      inst.state = { ...inst.state, ...statePatch };
    }
    return inst.render();
  }
  // 不同组件的 hook 序不同，跨组件渲染必须清空槽位，否则会串味
  // （前一组件 seed 过的 slot0 会被后一组件当作自己的第一个 useState 读走）。
  // 同一组件连续渲染则保留槽位，以便「先渲染 → 再 seed → 再渲染」的用例。
  if (Component !== lastRendered) {
    runtime.reset();
    lastRendered = Component;
  }
  return runtime.render(Component, props, statePatch);
}

const { AddMenu } = await import('../dist/ui/components/AddMenu.js');
const { ContextCapacityPanel } = await import('../dist/ui/components/ContextCapacityPanel.js');
const { PermissionPicker } = await import('../dist/ui/components/PermissionPicker.js');
const { TreeNode } = await import('../dist/ui/components/TreeNode.js');
const { PanelPicker } = await import('../dist/ui/components/PanelPicker.js');
const { Toast } = await import('../dist/ui/components/Toast.js');
const { WorkIndicator } = await import('../dist/ui/components/WorkIndicator.js');
const { ApprovalModal } = await import('../dist/ui/components/ApprovalModal.js');
const { DialogHost } = await import('../dist/ui/components/DialogHost.js');

/** 遍历 vnode 树：对每个节点调用 visit（跳过字符串/数字叶子）。 */
function walk(vnode, visit) {
  if (vnode == null || typeof vnode !== 'object') return;
  visit(vnode);
  const kids = vnode.children;
  if (Array.isArray(kids)) for (const k of kids) walk(k, visit);
  else walk(kids, visit);
}

/** 把 vnode 树拍平成「type 名 + 文本」序列，便于断言 UI 契约。 */
function flatten(vnode) {
  const out = [];
  walk(vnode, (n) => {
    const name = typeof n.type === 'function' ? n.type.name : String(n.type);
    out.push(name);
  });
  return out;
}

/** 收集树中的文本叶子。 */
function texts(vnode) {
  const out = [];
  walk(vnode, (n) => {
    for (const k of n.children ?? []) {
      if (typeof k === 'string' || typeof k === 'number') out.push(String(k));
    }
  });
  return out;
}

const ADD_MENU_PROPS = {
  threadId: 't-1',
  api: {},
  onAttach: () => {},
  onToast: () => {},
  onOpenTab: () => {},
  onOpenFile: () => {},
  onLoadThread: () => {},
};

test('AddMenu：初始即闭合态，render 产出根元素且不抛错（免 bootstrap 路径）', () => {
  const vnode = renderOf(AddMenu, ADD_MENU_PROPS);
  assert.ok(vnode, 'render 必须返回元素树');
  assert.strictEqual(vnode.props['aria-expanded'], 'false', '初始态必须闭合');
  const types = flatten(vnode);
  assert.ok(types.length > 0, '元素树非空');
});

test('AddMenu：闭合态渲染触发器（＋）且 aria 契约正确', () => {
  const vnode = renderOf(AddMenu, ADD_MENU_PROPS);
  assert.strictEqual(texts(vnode).join(''), '＋');
  assert.strictEqual(vnode.props['aria-haspopup'], 'menu');
  assert.strictEqual(vnode.props['aria-expanded'], 'false');
});

test('AddMenu：打开态 aria-expanded 翻转（UI 状态契约）', () => {
  // 函数组件：按 hook 序号预设 open=true（第 0 个 hook 即 useState(open)）。
  const vnode = renderOf(AddMenu, ADD_MENU_PROPS, { 0: true });
  assert.strictEqual(vnode.props['aria-expanded'], 'true');
});

test('ContextCapacityPanel：容量面板 title/aria 契约 + 注入用量不抛错', () => {
  const props = { threadId: 't-1', api: {}, onToast: () => {} };
  let vnode = renderOf(ContextCapacityPanel, props);
  assert.strictEqual(vnode.props.title, '上下文容量与今日余额');
  assert.strictEqual(vnode.props['aria-label'], '上下文容量');
  // 注入真实形状的用量/配额快照后仍可渲染（fail-soft：数据缺失显示占位）。
  // 函数组件：hook 序号 1=usage、2=quota（第 0 个为 useState(open)）。
  vnode = renderOf(ContextCapacityPanel, props, {
    1: { windowTokens: 128000, usedTokens: 4096, byKind: {} },
    2: { plan: 'free', multiplier: 1, dailyTokens: 200000, usedToday: 4096 },
  });
  assert.ok(vnode, '注入用量后 render 仍须返回元素树');
});

test('PermissionPicker：档位标签映射与 aria 契约（rules→默认）', () => {
  const seen = [];
  const vnode = renderOf(PermissionPicker, {
    permission: 'rules',
    onPick: (v) => seen.push(v),
    api: {},
  });
  assert.strictEqual(vnode.props['aria-label'], 'AI 权限等级');
  assert.match(texts(vnode).join(''), /默认/);
  assert.strictEqual(seen.length, 0, '未交互不触发 onPick');
});

test('TreeNode：文件树节点渲染名称并保留展开回调（零 DOM 依赖）', () => {
  const vnode = renderOf(TreeNode, {
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
  });
  const t = texts(vnode).join('\n');
  assert.match(t, /src/, '节点必须渲染名称');
});

/**
 * 深度收集满足谓词的节点。
 * 注意：上面的 walk() 遇到「子节点是数组」（如 `{ITEMS.map(...)}` 产生的嵌套数组）会断掉，
 * a11y 断言需要遍历 `.map` 出来的按钮列表，故此处自带一个能递归数组的收集器。
 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) collect(k, pred, out);
    return out;
  }
  if (vnode == null || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

const isTag = (name) => (n) => n.type === name;

test('PanelPicker：闭合态只渲染触发器（aria-haspopup=menu），展开态罗列全部 12 个面板', () => {
  // 2026-10-07 壳层重构：原 NavRail（9 常驻图标 + 「更多面板」兜底）收编为右栏的 PanelPicker
  // ——12 个功能面板不再常驻占位，全部收进这一个菜单（截图式三栏壳的"收起来"）。
  const closed = renderOf(PanelPicker, { activePane: 'tools', onPick: () => {} });
  const closedBtns = collect(closed, isTag('button'));
  assert.strictEqual(closedBtns.length, 1, '闭合态必须只有 1 个触发按钮');
  assert.strictEqual(closedBtns[0].props['aria-haspopup'], 'menu');
  assert.strictEqual(closedBtns[0].props['aria-expanded'], 'false');
  assert.strictEqual(closedBtns[0].props['aria-label'], '全部面板');

  // 函数组件：第 0 个 hook 即 useState(open)，预设 true 渲染展开态。
  const open = renderOf(PanelPicker, { activePane: 'tools', onPick: () => {} }, { 0: true });
  const items = collect(open, (n) => n.props.role === 'menuitem');
  assert.strictEqual(items.length, 12, '菜单必须罗列注册表全部 12 个面板');
  const labels = items.map((b) => b.props['aria-label'] ?? collect(b, isTag('span')).map((s) => s.children).flat().join(''));
  for (const l of ['工具', '指标', '设置', '插件', '编排', '记忆', '配置集', '钻取', '回滚', '变更', '治理', '文件']) {
    assert.ok(collect(open, isTag('span')).some((s) => (s.children ?? []).includes(l)), `菜单应含面板：${l}`);
  }
});

test('PanelPicker：激活面板在菜单中高亮（active class 唯一）', () => {
  const open = renderOf(PanelPicker, { activePane: 'memory', onPick: () => {} }, { 0: true });
  const items = collect(open, (n) => n.props.role === 'menuitem');
  const actives = items.filter((b) => String(b.props.className).includes('active'));
  assert.strictEqual(actives.length, 1, 'active class 必须有且仅有 1 个');
});

test('面板注册表：12 项齐全、key 唯一（「全部面板」菜单据此渲染，IA 缺口的机械判据）', async () => {
  // 2026-10-07 壳层重构后，注册表是 12 个面板的唯一事实源：PanelPicker 菜单渲染 PANELS 全集，
  // Router 的合法 pane 集合与它对齐 ⇒ "任何面板都必须有入口"由本用例机械核对。
  const { PANELS, panelOf } = await import('../dist/ui/models/PanelRegistry.js');
  assert.strictEqual(PANELS.length, 12, '注册表必须是 12 个面板');
  const keys = PANELS.map((p) => p.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'key 不得重复');
  for (const p of PANELS) {
    assert.ok(p.label.length > 0 && p.icon.length > 0, `${p.key} 必须同时有标签与图标`);
    assert.ok(panelOf(p.key) === p, `${p.key} 必须能被 panelOf 查到（菜单高亮据此判定）`);
  }
});

test('Toast：role=status + aria-live=polite + aria-atomic（异步提示不打断朗读）', () => {
  const vnode = renderOf(Toast, { toast: { message: '已保存', kind: 'ok', visible: true } });
  assert.strictEqual(vnode.props.role, 'status');
  assert.strictEqual(vnode.props['aria-live'], 'polite');
  assert.strictEqual(vnode.props['aria-atomic'], 'true');
  assert.strictEqual(texts(vnode).join(''), '已保存');
});

test('WorkIndicator：role=status 播报动作，跳动计时 aria-hidden 防每秒打断', () => {
  // 函数组件：按 hook 序号预设 elapsed = 7（第 0 个 hook 即 useState(elapsed)）。
  const vnode = renderOf(WorkIndicator, { activeTool: 'shell' }, { 0: 7 });
  assert.strictEqual(vnode.props.role, 'status');
  assert.strictEqual(vnode.props['aria-live'], 'polite');
  const hidden = collect(vnode, (n) => n.props['aria-hidden'] === 'true');
  assert.strictEqual(hidden.length, 2, '圆点与计时数字都应 aria-hidden');
  assert.match(texts(vnode).join('|'), /正在调用 shell/);
});

test('ApprovalModal：role=dialog + aria-modal + labelledby/describedby 且锚点存在', () => {
  const vnode = renderOf(ApprovalModal, {
    approval: { requestId: 'r1', toolName: 'shell', target: 'rm -rf /', args: { cmd: 'rm -rf /' } },
    onRespond: () => {},
  });
  const dialogs = collect(vnode, (n) => n.props.role === 'dialog');
  assert.strictEqual(dialogs.length, 1, '必须产出唯一 role=dialog 的模态框');
  assert.strictEqual(dialogs[0].props['aria-modal'], 'true');
  assert.strictEqual(dialogs[0].props['aria-labelledby'], 'ap-title');
  assert.strictEqual(dialogs[0].props['aria-describedby'], 'ap-desc');
  assert.strictEqual(collect(vnode, (n) => n.props.id === 'ap-title').length, 1, 'labelledby 必须指向存在的元素');
  assert.strictEqual(collect(vnode, (n) => n.props.id === 'ap-desc').length, 1, 'describedby 必须指向存在的元素');

  const idle = renderOf(ApprovalModal, { approval: null, onRespond: () => {} });
  assert.strictEqual(collect(idle, (n) => n.props.role === 'dialog').length, 0, '无请求时不得留可聚焦的对话框');
});

test('DialogHost：confirm 无输入框、prompt 有输入框，两者都有完整 dialog 语义', () => {
  const hidden = renderOf(DialogHost, { dialog: { request: null } });
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
  const vnode = renderOf(DialogHost, { dialog: { request: { ...base } } });
  const dialogs = collect(vnode, (n) => n.props.role === 'dialog');
  assert.strictEqual(dialogs.length, 1);
  assert.strictEqual(dialogs[0].props['aria-modal'], 'true');
  assert.strictEqual(dialogs[0].props['aria-labelledby'], 'dlg-title');
  assert.strictEqual(dialogs[0].props['aria-describedby'], 'dlg-body');
  assert.strictEqual(collect(vnode, isTag('input')).length, 0, 'confirm 不该渲染输入框');
  assert.match(texts(vnode).join('|'), /不可恢复/);

  // prompt：函数组件按 hook 序号预设 text='旧目标'（第 0 个 hook 即 useState(text)）。
  const promptVnode = renderOf(
    DialogHost,
    { dialog: { request: { ...base, kind: 'prompt', initial: '旧目标', placeholder: '例如' } } },
    { 0: '旧目标' },
  );
  const inputs = collect(promptVnode, isTag('input'));
  assert.strictEqual(inputs.length, 1, 'prompt 必须渲染输入框');
  assert.strictEqual(inputs[0].props.value, '旧目标');
  assert.strictEqual(inputs[0].props['aria-label'], '丢弃改动');
});

test('StreamView 契约：事件流容器是 role=log + aria-live=polite 的播报区', async () => {
  const { StreamView } = await import('../dist/ui/components/StreamView.js');
  const vnode = renderOf(StreamView, {
    events: [],
    toolResults: {},
    liveInputs: [],
    onEventClick: () => {},
    onSend: () => {},
    model: '',
    reasoning: '',
    permission: '',
    api: {},
    onModelChange: () => {},
    onReasoningChange: () => {},
    onPermissionChange: () => {},
  });
  const logs = collect(vnode, (n) => n.props.role === 'log');
  assert.strictEqual(logs.length, 1, '中栏事件流必须是唯一 role=log 播报区');
  assert.strictEqual(logs[0].props['aria-live'], 'polite');
  assert.strictEqual(logs[0].props['aria-label'], '对话事件流');
});
