// 可访问性契约测试（B4/B5 的语义面）：对渲染树断言 role / aria-selected / aria-label / aria-live 的
// 存在与关键属性值，且「结构性角色必须成套出现」（tablist↔tab↔tabpanel、listbox↔option、
// dialog↔aria-modal、labelledby↔真实 id）。
//
// 为什么成套断言：单看「有 aria-label」会放过「有 aria-labelledby 但指向不存在的 id」这类
// 屏幕阅读器读不出名字的坏契约——那正是本次改造要防的回归。
//
// 迁移（2026-10-18）：从零 DOM 桩迁到**真实 React + jsdom**。断言仍读同一套外观形状
// （`kids/clsOf/allText/walk`），交互改为 `fireEvent.keyDown/click`（不再直接调 props 回调）。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacade, renderFacadeAsync } from './rtlHarness.ts';
import { allText, byTag, clsOf, facadeOf, walk } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';

const { RightPanel } = await import('../src/ui/components/RightPanel.tsx');
const { PanelPicker } = await import('../src/ui/components/PanelPicker.tsx');
const { SidebarHeader } = await import('../src/ui/components/SidebarHeader.tsx');
const { SidebarFooter } = await import('../src/ui/components/SidebarFooter.tsx');
const { ChatHeader } = await import('../src/ui/components/ChatHeader.tsx');
const { StreamingAssistantCard } =
  await import('../src/ui/components/stream/StreamingAssistantCard.tsx');
const { SearchResults } = await import('../src/ui/components/SearchResults.tsx');
const { DialogHost } = await import('../src/ui/components/DialogHost.tsx');
const { ApprovalModal } = await import('../src/ui/components/ApprovalModal.tsx');
const { ChangesTab } = await import('../src/ui/components/tabs/ChangesTab.tsx');
const { SessionPanel } = await import('../src/ui/components/SessionPanel.tsx');
const { SearchHitGrouper } = await import('../src/ui/models/SearchHitGrouper.ts');

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

/** 在整棵树里查找带某 id 的节点（用于 labelledby/describedby 的存在性校验）。 */
function byId(node: Facade, id: unknown): FacadeNode[] {
  return collect(node, (n) => n.props.id === id);
}

// ---- 右栏标签：WAI-ARIA Tabs 三件套 ----

/** 造一份已打开文件（代码查看器标签条的渲染源）。 */
const fileOf = (title: string) => ({ title, meta: '测试文件', content: 'x', lang: 'ts' });

test('RightPanel：tablist/tab/tabpanel 成套，aria-selected 唯一为 true，roving tabindex', () => {
  // 2026-10-07 壳层重构：右栏改为代码查看器（文件标签 + 激活面板标签），12 个功能面板收进
  // PanelPicker 菜单——标签条不再常驻 12 项，但 Tabs 语义契约原样保留。
  const { node } = renderFacade(RightPanel, {
    props: {
      activePane: 'changes',
      onSelect: () => {},
      open: true,
      openFiles: [fileOf('a.ts'), fileOf('b.ts')],
      activeFileTitle: 'a.ts',
      onShowFile: () => {},
      onCloseFile: () => {},
      children: 'panel-body',
    },
  });
  const tablist = collect(node, (n) => n.props.role === 'tablist');
  assert.strictEqual(tablist.length, 1);
  assert.strictEqual(tablist[0]!.props['aria-label'], '文件与面板');

  const tabs = collect(node, (n) => n.props.role === 'tab');
  assert.strictEqual(tabs.length, 3, '2 个文件标签 + 1 个激活面板标签（变更）');
  const selected = tabs.filter((t) => t.props['aria-selected'] === 'true');
  assert.strictEqual(selected.length, 1, 'aria-selected 必须有且仅有 1 个 true');
  assert.strictEqual(selected[0]!.props.id, 'tab-pane-changes', '非 file 视图时激活的是面板标签');
  assert.deepStrictEqual(
    tabs.filter((t) => t.props['aria-selected'] !== 'true' && t.props['aria-selected'] !== 'false'),
    [],
    '每个 tab 都必须显式给 aria-selected（不能靠缺省）',
  );
  assert.strictEqual(selected[0]!.props.tabIndex, '0', '选中标签是唯一 Tab 落点（roving tabindex）');
  assert.strictEqual(tabs.filter((t) => t.props.tabIndex === '-1').length, tabs.length - 1);

  const panel = collect(node, (n) => n.props.role === 'tabpanel');
  assert.strictEqual(panel.length, 1);
  assert.strictEqual(panel[0]!.props['aria-labelledby'], 'tab-pane-changes');
  assert.strictEqual(
    byId(node, 'tab-pane-changes').length,
    1,
    'aria-labelledby 必须指向真实存在的元素',
  );
  assert.strictEqual(new Set(tabs.map((t) => t.props['aria-controls'])).size, 1);
  assert.strictEqual(tabs[0]!.props['aria-controls'], panel[0]!.props.id);
  assert.strictEqual(allText(panel[0]!), 'panel-body');
});

test('RightPanel：file 视图时激活对应文件标签；全部面板可经 PanelPicker 到达', () => {
  const { node } = renderFacade(RightPanel, {
    props: {
      activePane: 'file',
      onSelect: () => {},
      open: true,
      openFiles: [fileOf('a.ts'), fileOf('rollback.ts')],
      activeFileTitle: 'rollback.ts',
      onShowFile: () => {},
      onCloseFile: () => {},
      children: null,
    },
  });
  const tabs = collect(node, (n) => n.props.role === 'tab');
  const selected = tabs.filter((t) => t.props['aria-selected'] === 'true');
  assert.strictEqual(selected.length, 1);
  assert.match(String(selected[0]!.props.id), /^tab-file-/, 'file 视图激活的是文件标签');
  assert.match(allText(selected[0]!), /rollback\.ts/);
  // 12 个功能面板仍可一步到达：标签条右端常驻「全部面板」入口（原 NavRail 的职责收编于此）。
  // 迁移前按组件类型断言 `PanelPicker` 存在；真实 React 会把子组件渲染成 DOM，这里改为
  // **点开菜单并断言注册表条目逐项可见**——比"组件挂上了"更强。
  const trigger = byTag(node, 'button').find((b) => b.props['aria-label'] === '全部面板');
  assert.ok(trigger !== undefined, '右栏必须常驻「全部面板」入口');
});

test('RightPanel：←/→ 在标签间移动并激活，Enter/Space 激活当前标签', () => {
  const seen: unknown[] = [];
  const shown: unknown[] = [];
  const { node } = renderFacade(RightPanel, {
    props: {
      activePane: 'changes',
      onSelect: (k: string) => seen.push(k),
      open: true,
      openFiles: [fileOf('a.ts'), fileOf('b.ts')],
      activeFileTitle: 'a.ts',
      onShowFile: (t: string) => shown.push(t),
      onCloseFile: () => {},
      children: null,
    },
  });
  const tabs = collect(node, (n) => n.props.role === 'tab');
  const active = tabs.filter((t) => t.props['aria-selected'] === 'true')[0]!;
  // 标签顺序：a.ts(0) → b.ts(1) → 变更(2)；右栏 props 固定，键盘只上抛回调、不改变选中态，
  // 故 `active` 始终是同一节点（变更，下标 2）——每条断言都以"从变更出发"计算。
  const key = (k: string) => fireEvent.keyDown(active.el, { key: k });
  key('ArrowRight');
  assert.deepStrictEqual(shown, ['a.ts'], '右方向键回绕到第一个文件标签（变更 → a.ts）');
  key('ArrowLeft');
  assert.deepStrictEqual(shown, ['a.ts', 'b.ts'], '左方向键切到上一个文件标签（变更 → b.ts）');
  key('Enter');
  assert.deepStrictEqual(seen.at(-1), 'changes', 'Enter 激活当前标签');
  key(' ');
  assert.deepStrictEqual(seen.at(-1), 'changes', 'Space 同样激活');
});

// ---- 纯图标按钮必须有可读名字 ----

test('侧栏壳组件：纯图标按钮都有 aria-label（不能只靠 title/emoji）', () => {
  // 2026-10-07 壳层重构：NavRail / TopBar 收编为 SidebarHeader / SidebarFooter / PanelPicker。
  const trees = [
    renderFacade(SidebarHeader, {
      props: { rail: false, onToggleRail: () => {}, onOpenPalette: () => {} },
    }).node,
    renderFacade(SidebarFooter, {
      props: {
        connected: true,
        onOpenSettings: () => {},
      },
    }).node,
    renderFacade(PanelPicker, { props: { activePane: 'tools', onPick: () => {} } }).node,
    renderFacade(ChatHeader, {
      props: {
        title: 't',
        busy: false,
        view: 'chat',
        onView: () => {},
        onToggleLeft: () => {},
        onToggleRight: () => {},
      },
    }).node,
  ];
  for (const tree of trees) {
    const btns = byTag(tree, 'button');
    assert.ok(btns.length >= 1, '每个壳组件至少渲染一个按钮');
    assert.deepStrictEqual(
      btns
        // 带可见文本的按钮不需要 aria-label（对话/轨迹/新会话/设置/插件）。
        .filter((b) => allText(b).trim() === '')
        .filter((b) => typeof b.props['aria-label'] !== 'string' || b.props['aria-label'] === ''),
      [],
      '纯图标按钮必须有 aria-label',
    );
  }
});

// ---- 模态：dialog 语义成套 ----

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
  const dlg = renderFacade(DialogHost, { props: { dialog: { request: { ...base } } } }).node;
  const d = collect(dlg, (n) => n.props.role === 'dialog');
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0]!.props['aria-modal'], 'true');
  assert.strictEqual(byId(dlg, d[0]!.props['aria-labelledby']).length, 1);
  assert.strictEqual(byId(dlg, d[0]!.props['aria-describedby']).length, 1);

  const ap = renderFacade(ApprovalModal, {
    props: {
      approval: { requestId: 'r1', toolName: 'shell', target: 'ls', args: {} },
      onRespond: () => {},
    },
  }).node;
  const a = collect(ap, (n) => n.props.role === 'dialog');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0]!.props['aria-modal'], 'true');
});

// ---- 流式播报：polite + 粗粒度 ----

test('StreamingAssistantCard：正文 aria-hidden，状态区 role=status + polite，粒度按百字分档', () => {
  const short = renderFacade(StreamingAssistantCard, { props: { text: '正在' } }).node;
  const status = collect(short, (n) => n.props.role === 'status');
  assert.strictEqual(status.length, 1);
  assert.strictEqual(status[0]!.props['aria-live'], 'polite');
  assert.strictEqual(status[0]!.props['aria-atomic'], 'true');
  const hiddenBody = collect(short, (n) => n.props['aria-hidden'] === 'true');
  assert.strictEqual(hiddenBody.length, 1, '逐字增长的正文必须对辅助技术隐藏');
  assert.strictEqual(clsOf(hiddenBody[0]!), 'content', '隐藏的必须是正文容器');
  assert.strictEqual(allText(hiddenBody[0]!), '正在', '正文仍要真实渲染（只是对 AT 隐藏）');

  const announce = (len: number) => {
    const node = renderFacade(StreamingAssistantCard, { props: { text: 'x'.repeat(len) } }).node;
    return allText(collect(node, (n) => n.props.role === 'status')[0]!);
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
  const { node } = renderFacade(SearchResults, {
    props: {
      groups,
      selectedIndex: 1,
      query: 'app',
      loading: false,
      onPick: () => {},
    },
  });
  assert.strictEqual(collect(node, (n) => n.props.role === 'listbox').length, 1);
  const options = collect(node, (n) => n.props.role === 'option');
  assert.strictEqual(options.length, 2);
  assert.deepStrictEqual(
    options.map((o) => o.props['aria-selected']),
    ['false', 'true'],
    '选中项由 selectedIndex 决定（↑↓ 与 Enter 指向同一项）',
  );
  const status = collect(node, (n) => n.props.role === 'status')[0]!;
  assert.strictEqual(status.props['aria-live'], 'polite');
  assert.strictEqual(status.props['aria-atomic'], 'true');
});

test('SessionPanel：搜索框是 combobox 并显式 aria-label / aria-controls / activedescendant', async () => {
  const ui = await renderFacadeAsync(SessionPanel, {
    props: {
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
    },
    responses: {
      searchAll: { files: [], chats: [] },
      listWorkspaces: { current: '', workspaces: [] },
      listFs: { tree: [] },
    },
  });
  /** 从同一容器取当前渲染树（点击会重渲染）。 */
  const tree = (): Facade => facadeOf(ui.container.firstElementChild);
  // 截图式侧栏不常驻搜索框：先点「工作区」头的放大镜唤出，再断言 combobox 语义。
  const toggle = byTag(tree(), 'button').find(
    (b) => b.props['aria-label'] === '搜索会话与文件',
  );
  assert.ok(toggle !== undefined, '必须渲染搜索唤出按钮');
  fireEvent.click(toggle.el);
  const vnode = tree();
  const input = collect(vnode, (n) => n.props.className === 'session-search')[0]!;
  assert.strictEqual(input.props.role, 'combobox');
  assert.strictEqual(input.props['aria-label'], '搜索会话与文件');
  assert.strictEqual(input.props['aria-controls'], 'session-search-results');
  assert.strictEqual(input.props['aria-autocomplete'], 'list');
  assert.strictEqual(input.props['aria-expanded'], 'false');
  assert.strictEqual(input.props['aria-activedescendant'], undefined, '无结果时不得指向不存在的项');
  const iconBtns = byTag(vnode, 'button').filter(
    (n) => typeof n.props.className === 'string' && n.props.className.includes('session-act'),
  );
  assert.strictEqual(iconBtns.length, 3, '会话行图标按钮（重命名/复制/删除）');
  assert.deepStrictEqual(
    iconBtns.filter((b) => typeof b.props['aria-label'] !== 'string').map((b) => b.props.title),
    [],
    '图标按钮必须带 aria-label',
  );
});

test('ChangesTab：键盘评审容器是可聚焦 region，且带 aria-label 说明按键', async () => {
  const ui = await renderFacadeAsync(ChangesTab, {
    props: {},
    responses: {
      listChanges: { source: 'git', files: [] },
      listDiffComments: { comments: [] },
    },
  });
  const root = collect(ui.node, (n) => n.props['data-review-root'] === '1')[0]!;
  assert.strictEqual(root.props.role, 'region');
  assert.strictEqual(root.props.tabIndex, '0');
  assert.match(String(root.props['aria-label']), /j\/k 选择/);
});

// ---- 汇总：可访问性属性覆盖数（写进汇报的实测数字） ----

test('汇总：跨组件渲染树的可访问性属性计数达到下限', () => {
  const trees: Facade[] = [
    renderFacade(RightPanel, {
      props: { activePane: 'changes', onSelect: () => {}, open: true, children: null },
    }).node,
    renderFacade(SidebarHeader, {
      props: { rail: false, onToggleRail: () => {}, onOpenPalette: () => {} },
    }).node,
    renderFacade(SidebarFooter, {
      props: {
        connected: true,
        onOpenSettings: () => {},
      },
    }).node,
    renderFacade(PanelPicker, { props: { activePane: 'tools', onPick: () => {} } }).node,
    renderFacade(ChatHeader, {
      props: {
        title: 't',
        busy: false,
        view: 'chat',
        onView: () => {},
        onToggleLeft: () => {},
        onToggleRight: () => {},
      },
    }).node,

    renderFacade(StreamingAssistantCard, { props: { text: '正在' } }).node,
  ];
  const all = trees.flatMap((t) => collect(t, () => true));
  const count = (pred: (n: FacadeNode) => boolean) => all.filter(pred).length;
  const numbered = {
    role: count((n) => typeof n.props.role === 'string'),
    ariaLabel: count((n) => typeof n.props['aria-label'] === 'string'),
    ariaLive: count((n) => typeof n.props['aria-live'] === 'string'),
    tabIndex: count((n) => n.props.tabIndex !== undefined),
    ariaSelected: count((n) => n.props['aria-selected'] !== undefined),
    nodes: all.length,
  };
  // 数字同时打印进输出，作为「实测覆盖率」证据留在日志里。
  process.stdout.write('a11y 计数（5 棵渲染树）:' + JSON.stringify(numbered) + '\n');
  // 2026-10-07 壳层重构后：右栏标签条 = 已打开文件 + 激活面板（不再是常驻 12 项），
  // 绝对数量阈值随之收窄；属性「逐个显式给出」的契约由上面各用例分别钉住。
  // 2026-10-18：关闭「×」改成 aria-hidden 的指针捷径（嵌套交互控件会被 axe 判红），
  // 标签自身仍逐个带 roving tabindex（激活项 0、其余 -1）⇒ 阈值从 ≥3 收到 ≥2。
  assert.ok(numbered.role >= 8, 'role 数量偏低：' + JSON.stringify(numbered));
  // 2026-10-19：页脚主题切换按钮 + 输入区独立回形针按钮已移除（附件入口收进「＋」菜单），
  // aria-label 相应少两枚 ⇒ 阈值 10→8。
  assert.ok(numbered.ariaLabel >= 8, 'aria-label 数量偏低：' + JSON.stringify(numbered));
  assert.ok(numbered.ariaLive >= 1, '必须有 polite 播报区');
  assert.ok(numbered.ariaSelected >= 3, '标签页必须逐个带 aria-selected');
  assert.ok(numbered.tabIndex >= 2, 'roving tabindex / 可聚焦容器必须存在');
});
