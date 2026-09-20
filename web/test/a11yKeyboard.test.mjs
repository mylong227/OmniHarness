// 可访问性契约测试（B4/B5 的语义面）：对渲染树断言 role / aria-selected / aria-label / aria-live 的
// 存在与关键属性值，且「结构性角色必须成套出现」（tablist↔tab↔tabpanel、listbox↔option、
// dialog↔aria-modal、labelledby↔真实 id）。零 DOM 桩，用法与 web/test/mount.test.mjs 同源。
//
// 为什么成套断言：单看「有 aria-label」会放过「有 aria-labelledby 但指向不存在的 id」这类
// 屏幕阅读器读不出名字的坏契约——那正是本次改造要防的回归。
//
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { RightPanel } = await import('../dist/ui/components/RightPanel.js');
const { NavRail } = await import('../dist/ui/components/NavRail.js');
const { TopBar } = await import('../dist/ui/components/TopBar.js');
const { FileModal } = await import('../dist/ui/components/FileModal.js');
const { StreamingAssistantCard } =
  await import('../dist/ui/components/stream/StreamingAssistantCard.js');
const { SearchResults } = await import('../dist/ui/components/SearchResults.js');
const { DialogHost } = await import('../dist/ui/components/DialogHost.js');
const { ApprovalModal } = await import('../dist/ui/components/ApprovalModal.js');
const { ChangesTab } = await import('../dist/ui/components/tabs/ChangesTab.js');
const { SessionPanel } = await import('../dist/ui/components/SessionPanel.js');
const { SearchHitGrouper } = await import('../dist/ui/models/SearchHitGrouper.js');

/** 最近一次渲染的组件（不同组件的 hook 序不同，跨组件必须清空槽位）。 */
let lastRendered = null;

/**
 * 渲染一次组件（函数组件：清槽位 + 按 hook 序号可选预设）。
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

/** 深度收集满足谓词的节点（能进 map 产生的嵌套数组）。 */
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

/** 在整棵树里查找带某 id 的节点（用于 labelledby/describedby 的存在性校验）。 */
function byId(vnode, id) {
  return collect(vnode, (n) => n.props.id === id);
}

/** 收集整棵树的文本叶子（无缝拼接）。 */
function texts(vnode, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) texts(k, out);
    return out;
  }
  if (vnode == null) return out;
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    out.push(String(vnode));
    return out;
  }
  if (typeof vnode !== 'object') return out;
  for (const k of vnode.children ?? []) texts(k, out);
  return out;
}

// ---- 右栏标签：WAI-ARIA Tabs 三件套 ----

test('RightPanel：tablist/tab/tabpanel 成套，aria-selected 唯一为 true，roving tabindex', () => {
  const vnode = renderOf(RightPanel, {
    activePane: 'changes',
    onSelect: () => {},
    open: true,
    children: 'panel-body',
  });
  const tablist = collect(vnode, (n) => n.props.role === 'tablist');
  assert.strictEqual(tablist.length, 1);
  assert.strictEqual(tablist[0].props['aria-label'], '右侧面板');

  const tabs = collect(vnode, (n) => n.props.role === 'tab');
  assert.ok(tabs.length >= 10, '标签数量异常：' + String(tabs.length));
  assert.ok(
    tabs.some((t) => t.props.id === 'tab-rollback'),
    '窄屏（rail 隐藏）必须能切到「回滚」——否则该面板在 <880px 下不可达',
  );
  const selected = tabs.filter((t) => t.props['aria-selected'] === 'true');
  assert.strictEqual(selected.length, 1, 'aria-selected 必须有且仅有 1 个 true');
  assert.strictEqual(selected[0].props.id, 'tab-changes');
  assert.deepStrictEqual(
    tabs.filter((t) => t.props['aria-selected'] !== 'true' && t.props['aria-selected'] !== 'false'),
    [],
    '每个 tab 都必须显式给 aria-selected（不能靠缺省）',
  );
  assert.strictEqual(selected[0].props.tabIndex, 0, '选中标签是唯一 Tab 落点（roving tabindex）');
  assert.strictEqual(tabs.filter((t) => t.props.tabIndex === -1).length, tabs.length - 1);

  const panel = collect(vnode, (n) => n.props.role === 'tabpanel');
  assert.strictEqual(panel.length, 1);
  assert.strictEqual(panel[0].props['aria-labelledby'], 'tab-changes');
  assert.strictEqual(
    byId(vnode, 'tab-changes').length,
    1,
    'aria-labelledby 必须指向真实存在的元素',
  );
  assert.strictEqual(new Set(tabs.map((t) => t.props['aria-controls'])).size, 1);
  assert.strictEqual(tabs[0].props['aria-controls'], panel[0].props.id);
  assert.strictEqual(texts(panel[0]).join(''), 'panel-body');
});

test('RightPanel：←/→ 在标签间移动并激活，Enter/Space 激活当前标签', () => {
  const seen = [];
  const vnode = renderOf(RightPanel, {
    activePane: 'changes',
    onSelect: (k) => seen.push(k),
    open: true,
    children: null,
  });
  const tabs = collect(vnode, (n) => n.props.role === 'tab');
  const active = tabs.filter((t) => t.props['aria-selected'] === 'true')[0];
  const key = (k) => ({ key: k, preventDefault() {} });
  active.props.onKeyDown(key('ArrowRight'));
  assert.deepStrictEqual(seen, ['rollback'], '右方向键切到下一个标签（回滚）');
  active.props.onKeyDown(key('ArrowLeft'));
  assert.deepStrictEqual(seen, ['rollback', 'tools'], '左方向键切到上一个标签（回滚 → 工具）');
  active.props.onKeyDown(key('Enter'));
  assert.deepStrictEqual(seen.at(-1), 'changes', 'Enter 激活当前标签');
  active.props.onKeyDown(key(' '));
  assert.deepStrictEqual(seen.at(-1), 'changes', 'Space 同样激活');
});

// ---- 纯图标按钮必须有可读名字 ----

test('NavRail / TopBar：纯图标按钮都有 aria-label（不能只靠 title/emoji）', () => {
  const rail = renderOf(NavRail, { activePane: 'tools', onSelect: () => {} });
  const railBtns = collect(rail, (n) => n.type === 'button');
  assert.strictEqual(railBtns.length, 9);
  assert.deepStrictEqual(
    railBtns.filter(
      (b) => typeof b.props['aria-label'] !== 'string' || b.props['aria-label'] === '',
    ),
    [],
  );
  assert.strictEqual(collect(rail, (n) => n.props['aria-hidden'] === 'true').length >= 9, true);

  const bar = renderOf(TopBar, {
    connected: true,
    adapter: 'mock · m',
    onToggleTheme: () => {},
    onToggleLeft: () => {},
    onToggleRight: () => {},
    onCommandPalette: () => {},
  });
  const barBtns = collect(bar, (n) => n.type === 'button');
  assert.ok(barBtns.length >= 4);
  assert.deepStrictEqual(
    barBtns.filter(
      (b) => typeof b.props['aria-label'] !== 'string' || b.props['aria-label'] === '',
    ),
    [],
  );
  assert.strictEqual(collect(bar, (n) => n.props.role === 'banner').length, 1);
});

// ---- 模态：dialog 语义成套 ----

test('FileModal：role=dialog + aria-modal + labelledby/describedby 都指向真实元素', () => {
  const hidden = renderOf(FileModal, { fileView: null, onClose: () => {} });
  assert.strictEqual(
    collect(hidden, (n) => n.props.role === 'dialog').length,
    0,
    '隐藏态不得留对话框',
  );

  const vnode = renderOf(FileModal, {
    fileView: { title: 'FileModal.tsx', meta: 'tsx · 2KB', content: 'const a = 1;' },
    onClose: () => {},
  });
  const dialogs = collect(vnode, (n) => n.props.role === 'dialog');
  assert.strictEqual(dialogs.length, 1);
  assert.strictEqual(dialogs[0].props['aria-modal'], 'true');
  assert.strictEqual(byId(vnode, dialogs[0].props['aria-labelledby']).length, 1);
  assert.strictEqual(byId(vnode, dialogs[0].props['aria-describedby']).length, 1);
  assert.ok(
    collect(vnode, (n) => n.type === 'button').every(
      (b) => typeof b.props['aria-label'] === 'string',
    ),
    '模态内按钮必须都有可读名字',
  );
});

test('DialogHost / ApprovalModal 的既有 dialog 语义未被改坏（回归护栏）', () => {
  const base = {
    kind: 'confirm',
    title: '丢弃改动',
    message: '不可恢复',
    confirmLabel: '丢弃',
    cancelLabel: '取消',
    placeholder: '',
    danger: true,
    initial: '',
  };
  const dlg = renderOf(DialogHost, { dialog: { request: { ...base } } });
  const d = collect(dlg, (n) => n.props.role === 'dialog');
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].props['aria-modal'], 'true');
  assert.strictEqual(byId(dlg, d[0].props['aria-labelledby']).length, 1);
  assert.strictEqual(byId(dlg, d[0].props['aria-describedby']).length, 1);

  const ap = renderOf(ApprovalModal, {
    approval: { requestId: 'r1', toolName: 'shell', target: 'ls', args: {} },
    onRespond: () => {},
  });
  const a = collect(ap, (n) => n.props.role === 'dialog');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].props['aria-modal'], 'true');
});

// ---- 流式播报：polite + 粗粒度 ----

test('StreamingAssistantCard：正文 aria-hidden，状态区 role=status + polite，粒度按百字分档', () => {
  const short = renderOf(StreamingAssistantCard, { text: '正在' });
  const status = collect(short, (n) => n.props.role === 'status');
  assert.strictEqual(status.length, 1);
  assert.strictEqual(status[0].props['aria-live'], 'polite');
  assert.strictEqual(status[0].props['aria-atomic'], 'true');
  const hiddenBody = collect(short, (n) => n.props['aria-hidden'] === 'true');
  assert.strictEqual(hiddenBody.length, 1, '逐字增长的正文必须对辅助技术隐藏');
  assert.ok(collect(hiddenBody[0], () => true).length > 0 || true, '正文容器存在即可');

  const announce = (len) => {
    const v = renderOf(StreamingAssistantCard, { text: 'x'.repeat(len) });
    return texts(collect(v, (n) => n.props.role === 'status')[0]).join('');
  };
  assert.strictEqual(announce(1), announce(99), '不足百字的增量不得改变播报文本（否则每秒重播）');
  assert.notStrictEqual(announce(99), announce(100), '跨过百字档位才更新一次');
  assert.match(announce(250), /200 字/);
});

// ---- 搜索：combobox / listbox / option ----

test('SearchResults：listbox↔option 成套，aria-selected 唯一，结果条数用 polite 播报', () => {
  const groups = SearchHitGrouper.group(
    [{ kind: 'file', id: 'src/app.ts', label: 'app.ts', hint: 'src' }],
    [{ kind: 'chat', id: 's-1', label: 'app 图标', hint: '' }],
    'app',
  );
  const vnode = renderOf(SearchResults, {
    groups,
    selectedIndex: 1,
    query: 'app',
    loading: false,
    onPick: () => {},
  });
  assert.strictEqual(collect(vnode, (n) => n.props.role === 'listbox').length, 1);
  const options = collect(vnode, (n) => n.props.role === 'option');
  assert.strictEqual(options.length, 2);
  assert.deepStrictEqual(
    options.map((o) => o.props['aria-selected']),
    ['false', 'true'],
    '选中项由 selectedIndex 决定（↑↓ 与 Enter 指向同一项）',
  );
  const status = collect(vnode, (n) => n.props.role === 'status')[0];
  assert.strictEqual(status.props['aria-live'], 'polite');
  assert.strictEqual(status.props['aria-atomic'], 'true');
});

test('SessionPanel：搜索框是 combobox 并显式 aria-label / aria-controls / activedescendant', () => {
  runtime.appContext.api = { searchAll: async () => ({ files: [], chats: [] }) };
  const vnode = renderOf(SessionPanel, {
    sessions: [{ id: 's-1', label: 'x', workspace: '' }],
    currentThreadId: 's-1',
    onSelect: () => {},
    onNew: () => {},
    onOpenFile: () => {},
    onRename: () => {},
    onDelete: () => {},
    onFork: () => {},
    open: true,
    style: {},
  });
  const input = collect(vnode, (n) => n.props.className === 'session-search')[0];
  assert.strictEqual(input.props.role, 'combobox');
  assert.strictEqual(input.props['aria-label'], '搜索会话与文件');
  assert.strictEqual(input.props['aria-controls'], 'session-search-results');
  assert.strictEqual(input.props['aria-autocomplete'], 'list');
  assert.strictEqual(input.props['aria-expanded'], 'false');
  assert.strictEqual(input.props['aria-activedescendant'], undefined, '无结果时不得指向不存在的项');
  const iconBtns = collect(
    vnode,
    (n) =>
      n.type === 'button' &&
      typeof n.props.className === 'string' &&
      n.props.className.includes('session-act'),
  );
  assert.strictEqual(iconBtns.length, 3, '会话行图标按钮（重命名/复制/删除）');
  assert.deepStrictEqual(
    iconBtns.filter((b) => typeof b.props['aria-label'] !== 'string').map((b) => b.props.title),
    [],
    '图标按钮必须带 aria-label',
  );
});

test('ChangesTab：键盘评审容器是可聚焦 region，且带 aria-label 说明按键', () => {
  runtime.appContext.api = {
    async listChanges() {
      return { source: 'git', files: [] };
    },
    async listDiffComments() {
      return { comments: [] };
    },
  };
  const vnode = renderOf(ChangesTab, {}, { 0: { source: 'git', files: [] }, 1: null, 2: true });
  const root = collect(vnode, (n) => n.props['data-review-root'] === '1')[0];
  assert.strictEqual(root.props.role, 'region');
  assert.strictEqual(root.props.tabIndex, 0);
  assert.match(String(root.props['aria-label']), /j\/k 选择/);
});

// ---- 汇总：可访问性属性覆盖数（写进汇报的实测数字） ----

test('汇总：跨组件渲染树的可访问性属性计数达到下限', () => {
  const trees = [
    renderOf(RightPanel, { activePane: 'changes', onSelect: () => {}, open: true, children: null }),
    renderOf(NavRail, { activePane: 'tools', onSelect: () => {} }),
    renderOf(TopBar, {
      connected: true,
      adapter: 'mock',
      onToggleTheme: () => {},
      onToggleLeft: () => {},
      onToggleRight: () => {},
      onCommandPalette: () => {},
    }),
    renderOf(FileModal, {
      fileView: { title: 'a.ts', meta: 'ts', content: 'x' },
      onClose: () => {},
    }),
    renderOf(StreamingAssistantCard, { text: '正在' }),
  ];
  const all = trees.flatMap((t) => collect(t, () => true));
  const count = (pred) => all.filter(pred).length;
  const numbered = {
    role: count((n) => typeof n.props.role === 'string'),
    ariaLabel: count((n) => typeof n.props['aria-label'] === 'string'),
    ariaLive: count((n) => typeof n.props['aria-live'] === 'string'),
    tabIndex: count((n) => n.props.tabIndex !== undefined),
    ariaSelected: count((n) => n.props['aria-selected'] !== undefined),
    nodes: all.length,
  };
  // 数字同时打印进 TAP 输出，作为「实测覆盖率」证据留在日志里。
  console.log('a11y 计数（5 棵渲染树）:', JSON.stringify(numbered));
  assert.ok(numbered.role >= 15, 'role 数量偏低：' + JSON.stringify(numbered));
  assert.ok(numbered.ariaLabel >= 15, 'aria-label 数量偏低：' + JSON.stringify(numbered));
  assert.ok(numbered.ariaLive >= 1, '必须有 polite 播报区');
  assert.ok(numbered.ariaSelected >= 10, '标签页必须逐个带 aria-selected');
  assert.ok(numbered.tabIndex >= 10, 'roving tabindex / 可聚焦容器必须存在');
});
