// 会话搜索升级（A3）：服务端 search.all 的分组/确定性排序/高亮，以及 ↑↓/Enter 与「无输入不打远端」。
//
// 关键口径：
//   · 确定性：把同一批命中打乱顺序喂进去，输出必须逐项一致（同输入恒同序）；
//   · 无输入不打远端：用桩 api 记录调用次数，空/纯空白关键字必须 0 次；
//   · 组件层用 scheduleSearch 注入「只保留最后一次」的调度器，把防抖变成可断言行为
//     （而不是等 220ms 碰运气）。
//
// 迁移（2026-10-18）：组件用例从「hook 槽位预设 query/结果 + 直接调 props.onChange」改为
// **真实 React + 真实输入**：`userEvent.type` 驱动受控输入，`scheduleSearch` 手动 flush 控制
// 防抖时机，`fireEvent.keyDown` 走真实的键盘处理器。断言改为 DOM 语义（aria-* / role / 文案）。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, renderFacade, renderFacadeAsync } from './rtlHarness.ts';
import { allText, byClass, byTag, clsOf, facadeOf } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';
import type { SearchHit } from '../src/types/models.ts';
import type { SearchAllResult } from '../src/ui/models/SessionSearch.ts';

const { SearchHitGrouper } = await import('../src/ui/models/SearchHitGrouper.ts');
const { SessionSearch } = await import('../src/ui/models/SessionSearch.ts');
const { SessionPanel } = await import('../src/ui/components/SessionPanel.tsx');
const { SearchResults } = await import('../src/ui/components/SearchResults.tsx');

/** 会话命中（故意乱序，用于验证排序确实由前端定序）。 */
const CHATS: SearchHit[] = [
  { kind: 'chat', id: 's-2', label: '重构 app 启动', hint: '2026-09-19T10:00:00Z' },
  { kind: 'chat', id: 's-1', label: 'app 图标', hint: '2026-09-18T10:00:00Z' },
];
/** 文件命中（故意乱序 + 长路径，验证「基名命中优先、短标签优先、id 兜底」）。 */
const FILES: SearchHit[] = [
  { kind: 'file', id: 'web/src/ui/App.tsx', label: 'App.tsx', hint: 'web/src/ui' },
  { kind: 'file', id: 'src/app.ts', label: 'app.ts', hint: 'src' },
];

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** 手写调度器：把防抖回调攒起来，由测试显式 flush（确定性，不依赖真实定时器）。 */
function manualScheduler() {
  const queue: (((() => void) | null))[] = [];
  return {
    schedule(fn: () => void): number {
      queue.push(fn);
      return queue.length;
    },
    cancel(handle: unknown) {
      // 句柄由 schedule 返回（必为 number）；显式断言不改运行时（原实现同样做算术）。
      queue[(handle as number) - 1] = null;
    },
    flush() {
      const pending = queue.splice(0, queue.length);
      for (const fn of pending) if (fn) fn();
    },
  };
}

// ---- 模型层 ----

test('SearchHitGrouper.sort：同输入恒同序（打乱喂入逐项一致）', () => {
  const a = SearchHitGrouper.sort(FILES, 'app');
  const b = SearchHitGrouper.sort([...FILES].reverse(), 'app');
  assert.deepStrictEqual(
    a.map((h) => h.id),
    b.map((h) => h.id),
    '顺序必须与输入顺序无关',
  );
  assert.deepStrictEqual(
    a.map((h) => h.id),
    ['src/app.ts', 'web/src/ui/App.tsx'],
    '短标签优先',
  );
});

test('SearchHitGrouper.sort：命中位置优先于标签长度（前缀命中排前）', () => {
  const hits: SearchHit[] = [
    { kind: 'file', id: 'x/a-long-name-app.ts', label: 'a-long-name-app.ts', hint: 'x' },
    { kind: 'file', id: 'y/app.ts', label: 'app.ts', hint: 'y' },
  ];
  const sorted = SearchHitGrouper.sort(hits, 'app');
  assert.strictEqual(sorted[0].id, 'y/app.ts', '位置 0 的命中优先');
});

test('SearchHitGrouper.sort：完全并列时用 id 兜底（总序，绝不出现不稳定顺序）', () => {
  const hits: SearchHit[] = [
    { kind: 'file', id: 'b/app.ts', label: 'app.ts', hint: 'b' },
    { kind: 'file', id: 'a/app.ts', label: 'app.ts', hint: 'a' },
  ];
  assert.deepStrictEqual(
    SearchHitGrouper.sort(hits, 'app').map((h) => h.id),
    ['a/app.ts', 'b/app.ts'],
  );
});

test('SearchHitGrouper.group：会话组在前、空组不产出、每组受 LIMIT 约束', () => {
  const groups = SearchHitGrouper.group(FILES, CHATS, 'app');
  assert.deepStrictEqual(
    groups.map((g) => g.kind),
    ['chat', 'file'],
  );
  assert.deepStrictEqual(
    groups[0].items.map((h) => h.id),
    ['s-1', 's-2'],
  );
  assert.deepStrictEqual(
    groups[1].items.map((h) => h.id),
    ['src/app.ts', 'web/src/ui/App.tsx'],
  );
  assert.deepStrictEqual(SearchHitGrouper.group([], [], 'app'), [], '空结果不产出空组');

  const many: SearchHit[] = Array.from({ length: 30 }, (_, i) => ({
    kind: 'file',
    id: 'f' + String(i) + '.app',
    label: 'f' + String(i) + '.app',
    hint: '.',
  }));
  const capped = SearchHitGrouper.group(many, [], 'app');
  assert.strictEqual(capped[0].items.length, SearchHitGrouper.LIMIT);
});

test('SearchHitGrouper.snippet / segments：命中片段截断且高亮分段正确', () => {
  const long = 'x'.repeat(80) + 'needle' + 'y'.repeat(80);
  const cut = SearchHitGrouper.snippet(long, 'needle', 40);
  assert.ok(cut.length <= 42, '截断长度受控（含省略号）：' + String(cut.length));
  assert.match(cut, /needle/, '截断窗口必须包含命中词');
  assert.match(cut, /^…/, '左侧截断要有省略号');
  assert.strictEqual(SearchHitGrouper.snippet('短文本', 'x', 40), '短文本');

  const segs = SearchHitGrouper.segments('src/app.ts', 'app');
  assert.deepStrictEqual(segs, [
    { text: 'src/', hit: false },
    { text: 'app', hit: true },
    { text: '.ts', hit: false },
  ]);
  assert.deepStrictEqual(SearchHitGrouper.segments('abc', ''), [{ text: 'abc', hit: false }]);
});

test('SearchHitGrouper.move：越界夹取，空列表归 -1', () => {
  assert.strictEqual(SearchHitGrouper.move(-1, 1, 3), 0);
  assert.strictEqual(SearchHitGrouper.move(0, 1, 3), 1);
  assert.strictEqual(SearchHitGrouper.move(2, 1, 3), 2);
  assert.strictEqual(SearchHitGrouper.move(0, -1, 3), 0);
  assert.strictEqual(SearchHitGrouper.move(-1, 1, 0), -1);
});

test('SessionSearch：空关键字不发远端请求；连打合并成一次防抖请求', async () => {
  const calls: string[] = [];
  const sched = manualScheduler();
  const s = new SessionSearch({
    search: async (q) => {
      calls.push(q);
      return { files: FILES, chats: CHATS };
    },
    onUpdate: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  s.setQuery('   ');
  sched.flush();
  await flush();
  assert.deepStrictEqual(calls, [], '纯空白关键字必须一次远端都不打');

  s.setQuery('a');
  s.setQuery('ap');
  s.setQuery('app');
  assert.deepStrictEqual(calls, [], '防抖期内不得发请求');
  assert.strictEqual(s.isLoading(), true);
  sched.flush();
  await flush();
  assert.deepStrictEqual(calls, ['app'], '三次连打只应合并为一次 app 请求');
  assert.strictEqual(s.isLoading(), false);
  assert.strictEqual(s.selectedIndex(), 0, '结果到达即选中首项');
  // 用例序列已保证此处必有选中项（上一行刚断言 selectedIndex() === 0）。
  assert.strictEqual(s.selected()!.id, 's-1');
});

test('SessionSearch：陈旧响应不得覆盖新结果（防乱序回跳）', async () => {
  const resolvers: { q: string; resolve: (r: SearchAllResult) => void }[] = [];
  const s = new SessionSearch({
    search: (q) => new Promise((resolve) => resolvers.push({ q, resolve })),
    onUpdate: () => {},
    schedule: (fn) => {
      fn();
      return 0;
    },
    cancel: () => {},
  });
  s.setQuery('first');
  s.setQuery('second');
  assert.strictEqual(resolvers.length, 2);
  resolvers[1].resolve({
    files: [],
    chats: [{ kind: 'chat', id: 'new', label: 'second', hint: '' }],
  });
  await flush();
  // resolvers[1] 刚在上面断言过 length === 2。
  assert.strictEqual(s.selected()!.id, 'new');
  resolvers[0].resolve({
    files: [],
    chats: [{ kind: 'chat', id: 'stale', label: 'first', hint: '' }],
  });
  await flush();
  assert.strictEqual(s.selected()!.id, 'new', '先发后到的旧结果必须被丢弃');
});

test('SessionSearch：清空关键字即丢弃在途响应与结果', async () => {
  const resolvers: ((r: SearchAllResult) => void)[] = [];
  const s = new SessionSearch({
    search: () => new Promise((resolve) => resolvers.push(resolve)),
    onUpdate: () => {},
    schedule: (fn) => {
      fn();
      return 0;
    },
    cancel: () => {},
  });
  s.setQuery('x');
  s.setQuery('');
  resolvers[0]?.({ files: FILES, chats: CHATS });
  await flush();
  assert.strictEqual(s.selectedIndex(), -1);
  assert.deepStrictEqual(s.groupList(), []);
  assert.strictEqual(s.selected(), null);
});

// ---- 组件层 ----

/**
 * 「只保留最后一次」的调度器。
 *
 * 组件只暴露 `scheduleSearch`（不暴露 cancel），所以用「后一次覆盖前一次」模拟防抖重置：
 * 连打 N 个字符只会留下最后一次回调，`flush()` 后恰好发一次远端请求。
 * 这与真实 setTimeout 防抖的可观察行为一致，且不需要等真实定时器。
 */
function latestOnlyScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule(fn: () => void): number {
      pending = fn;
      return 1;
    },
    flush(): void {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

/** 装配 SessionPanel 的渲染与调用记录。 */
async function setupPanel() {
  const calls = { searchAll: [] as string[], opened: [] as string[], selected: [] as string[] };
  const sched = latestOnlyScheduler();
  const responses: Record<string, unknown> = {
    async searchAll(q: string) {
      calls.searchAll.push(q);
      return { files: FILES, chats: CHATS };
    },
    async listWorkspaces() {
      return { current: '', workspaces: [] };
    },
    async listFs() {
      return { tree: [] };
    },
  };
  const props = {
    sessions: [
      { id: 's-1', label: 'app 图标', workspace: '' },
      { id: 's-9', label: '无关会话', workspace: '' },
    ],
    currentThreadId: 's-1',
    onSelect: (id: string) => calls.selected.push(id),
    onNew: () => {},
    onOpenFile: (p: string) => calls.opened.push(p),
    onRename: () => {},
    onDelete: () => {},
    onFork: () => {},
    open: true,
    style: {},
    // 同步调度：把防抖变成「flush 即执行」，测试无需等真实定时器。
    scheduleSearch: (fn: () => void) => sched.schedule(fn),
  };
  const ui = await renderFacadeAsync(SessionPanel, { props, responses, onToast: () => {} });
  /** 从同一容器取当前渲染树（输入/点击都会重渲染）。 */
  const tree = (): Facade => facadeOf(ui.container.firstElementChild);
  return { ui, tree, calls, props, responses, sched };
}

/** 找到搜索输入框（未唤出时为 undefined）。 */
function searchInput(tree: Facade): FacadeNode | undefined {
  return byClass(tree, 'session-search')[0];
}

/**
 * 唤出搜索框（点「工作区」区块头的放大镜）。
 *
 * 2026-10-07 壳层重构：截图式侧栏**不常驻**搜索框，由放大镜按钮唤出。
 * 旧用例用「渲染一次 → 调 props.onClick → 再渲染一次」模拟；这里直接点真实按钮。
 *
 * @param handle setupPanel 的返回值
 * @returns 唤出后重新取的输入框
 */
async function openSearch(handle: Awaited<ReturnType<typeof setupPanel>>): Promise<FacadeNode> {
  const toggle = byTag(handle.tree(), 'button').find(
    (btn) => btn.props['aria-label'] === '搜索会话与文件',
  );
  assert.ok(toggle !== undefined, '必须渲染搜索唤出按钮（工作区头的放大镜）');
  fireEvent.click(toggle.el);
  await act(async () => {
    await Promise.resolve();
  });
  const input = searchInput(handle.tree());
  assert.ok(input !== undefined, '唤出后必须渲染搜索框');
  return input;
}

/**
 * 在输入框里输入关键字（受控输入必须走 userEvent）。
 * @param input 输入框外观节点
 * @param text 关键字
 * @returns 无
 */
async function typeQuery(input: FacadeNode, text: string): Promise<void> {
  const user = userEvent.setup();
  await user.clear(input.el as HTMLElement);
  // `user.type` 的按键描述不支持空串（空串只需 clear 已经表达"清空"）。
  if (text !== '') await user.type(input.el as HTMLElement, text);
}

/**
 * flush 防抖并等远端结果落到 DOM。
 * @param handle setupPanel 的返回值
 * @returns 无
 */
async function runSearch(handle: Awaited<ReturnType<typeof setupPanel>>): Promise<void> {
  handle.sched.flush();
  await act(async () => {
    await flush();
  });
}

test('SessionPanel：无输入（含纯空白）时一次远端搜索都不发', async () => {
  const handle = await setupPanel();
  const input = await openSearch(handle);
  assert.strictEqual(input.props.role, 'combobox');
  assert.strictEqual(input.props['aria-expanded'], 'false', '无关键字时不展开结果');

  await typeQuery(searchInput(handle.tree())!, '');
  await typeQuery(searchInput(handle.tree())!, '   ');
  await runSearch(handle);
  assert.deepStrictEqual(handle.calls.searchAll, [], '空关键字不得打远端');
  assert.strictEqual(searchInput(handle.tree())!.props['aria-expanded'], 'false');
});

test('SessionPanel：有关键字即打 search.all，并把分组结果渲染成 listbox', async () => {
  const handle = await setupPanel();
  const input = await openSearch(handle);
  await typeQuery(input, 'app');
  await runSearch(handle);
  assert.deepStrictEqual(handle.calls.searchAll, ['app'], '有输入必须打一次远端搜索');

  const tree = handle.tree();
  const listbox = byTag(tree, 'div').find((n) => n.props.role === 'listbox');
  assert.ok(listbox !== undefined, '必须渲染搜索结果视图');
  assert.strictEqual(listbox.props.id, 'session-search-results');
  assert.deepStrictEqual(
    byTag(tree, 'div')
      .filter((n) => n.props.role === 'group')
      .map((g) => g.props['aria-label']),
    ['会话', '工作区文件'],
    '会话组在前、文件组在后',
  );
  const options = byTag(tree, 'div').filter((n) => n.props.role === 'option');
  assert.strictEqual(options.length, 4, '会话 2 + 文件 2');
  assert.deepStrictEqual(
    options.map((o) => o.props.id),
    ['sr-opt-0', 'sr-opt-1', 'sr-opt-2', 'sr-opt-3'],
  );

  const current = searchInput(tree)!;
  assert.strictEqual(current.props['aria-expanded'], 'true');
  assert.strictEqual(current.props['aria-controls'], 'session-search-results');
  assert.strictEqual(current.props['aria-activedescendant'], 'sr-opt-0');
  assert.strictEqual(current.props['aria-autocomplete'], 'list');
});

test('SearchResults：listbox/option 语义 + aria-selected + 命中高亮 + 条数播报', () => {
  const picked: unknown[] = [];
  const groups = SearchHitGrouper.group(FILES, CHATS, 'app');
  const { node } = renderFacade(SearchResults, {
    props: {
      groups,
      selectedIndex: 0,
      query: 'app',
      loading: false,
      onPick: (hit: unknown) => picked.push(hit),
    },
  });
  const options = byTag(node, 'div').filter((n) => n.props.role === 'option');
  assert.strictEqual(options.length, 4, '会话 2 + 文件 2');
  assert.deepStrictEqual(
    options.map((o) => o.props.id),
    ['sr-opt-0', 'sr-opt-1', 'sr-opt-2', 'sr-opt-3'],
  );
  assert.deepStrictEqual(
    options.map((o) => o.props['aria-selected']),
    ['true', 'false', 'false', 'false'],
  );
  const listbox = byTag(node, 'div').find((n) => n.props.role === 'listbox')!;
  assert.strictEqual(listbox.props.id, 'session-search-results');
  assert.deepStrictEqual(
    byTag(node, 'div')
      .filter((n) => n.props.role === 'group')
      .map((g) => g.props['aria-label']),
    ['会话', '工作区文件'],
  );
  const marks = byTag(node, 'mark');
  assert.ok(marks.length >= 4, '命中片段必须用 mark 高亮（实际 ' + String(marks.length) + ' 处）');
  assert.match(allText(node), /找到 4 条结果/, '必须播报结果条数');
  const status = byTag(node, 'div').find((n) => n.props.role === 'status');
  assert.ok(status !== undefined, '必须有 polite 播报区');
  assert.strictEqual(status.props['aria-live'], 'polite');

  // 点击走的是 onMouseDown（避免 blur 丢焦点）：必须回传被点中的那一条。
  fireEvent.mouseDown(options[2]!.el);
  assert.deepStrictEqual(picked, [
    { kind: 'file', id: 'src/app.ts', label: 'app.ts', hint: 'src' },
  ]);
});

test('SearchResults：无关键字整块不渲染（空间还给本地会话列表）', () => {
  const { node } = renderFacade(SearchResults, {
    props: {
      groups: [],
      selectedIndex: -1,
      query: '   ',
      loading: false,
      onPick: () => {},
    },
  });
  assert.strictEqual(node, null);
});

/** 是否为带某 class 的元素（按空格切分，避免 `session` 命中 `session-toolbar`）。 */
function hasClass(node: FacadeNode, name: string) {
  return clsOf(node).split(' ').includes(name);
}

test('SessionPanel：本地即时过滤保留（无输入也生效，且与远端结果无关）', async () => {
  const handle = await setupPanel();
  const input = await openSearch(handle);
  // 输入 app 但**不 flush 防抖**：模拟「关键字已生效、远端尚未回」的本地过滤态。
  await typeQuery(input, 'app');
  const rows = byClass(handle.tree(), 'session').filter((n) => hasClass(n, 'session'));
  assert.strictEqual(rows.length, 1, '本地过滤必须只留下匹配会话');

  await typeQuery(searchInput(handle.tree())!, 'zzz');
  assert.match(allText(handle.tree()), /暂无会话/, '无匹配时必须落到空态文案');
});

test('SessionPanel：↑/↓ 移动选中、Enter 打开会话、再 Enter 打开文件', async () => {
  const handle = await setupPanel();
  const input = await openSearch(handle);
  await typeQuery(input, 'app');
  await runSearch(handle);

  const key = (k: string) => {
    fireEvent.keyDown(searchInput(handle.tree())!.el, { key: k });
  };

  key('ArrowUp');
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(
    searchInput(handle.tree())!.props['aria-activedescendant'],
    'sr-opt-0',
    '首项再按 ↑ 夹取',
  );

  key('ArrowDown');
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(searchInput(handle.tree())!.props['aria-activedescendant'], 'sr-opt-1');

  key('Enter');
  await act(async () => {
    await flush();
  });
  assert.deepStrictEqual(handle.calls.selected, ['s-2'], 'Enter 打开的是当前选中的会话（第 2 项）');
  assert.deepStrictEqual(handle.calls.opened, []);
  assert.deepStrictEqual(handle.calls.searchAll, ['app'], '打开后清空关键字不得再打远端');
  assert.strictEqual(searchInput(handle.tree())!.props.value, '', '打开后关键字清空');

  // 重新搜索 → 下移到第一个文件命中 → Enter 走文件预览
  await typeQuery(searchInput(handle.tree())!, 'app');
  await runSearch(handle);
  key('ArrowDown');
  await act(async () => {
    await Promise.resolve();
  });
  key('ArrowDown');
  await act(async () => {
    await Promise.resolve();
  });
  assert.strictEqual(searchInput(handle.tree())!.props['aria-activedescendant'], 'sr-opt-2');
  key('Enter');
  await act(async () => {
    await flush();
  });
  assert.deepStrictEqual(handle.calls.opened, ['src/app.ts'], '文件命中 Enter 必须在右侧预览');
});

test('SessionPanel：Esc 清空关键字并收起结果（不再打远端）', async () => {
  const handle = await setupPanel();
  const input = await openSearch(handle);
  await typeQuery(input, 'app');
  await runSearch(handle);
  assert.ok(
    byTag(handle.tree(), 'div').some((n) => n.props.role === 'listbox'),
    '输入后必须出现结果列表',
  );

  fireEvent.keyDown(searchInput(handle.tree())!.el, { key: 'Escape' });
  await act(async () => {
    await Promise.resolve();
  });
  const tree = handle.tree();
  assert.strictEqual(searchInput(tree)!.props.value, '', 'Esc 必须清空关键字');
  assert.ok(
    !byTag(tree, 'div').some((n) => n.props.role === 'listbox'),
    'Esc 必须收起结果',
  );
  assert.strictEqual(searchInput(tree)!.props['aria-expanded'], 'false');
  assert.deepStrictEqual(handle.calls.searchAll, ['app'], 'Esc 后不得补打远端');
});

test('SessionPanel：右键「配置」展开管理动作，且菜单内点击不会把分组关掉', async () => {
  const handle = await setupPanel();
  const row = byClass(handle.tree(), 'session').filter((n) => hasClass(n, 'session'))[0];
  assert.ok(row !== undefined, '必须先有会话行');
  fireEvent.contextMenu(row.el, { clientX: 120, clientY: 200 });
  await act(async () => {
    await Promise.resolve();
  });
  const menu = byClass(handle.tree(), 'row-menu')[0];
  assert.ok(menu !== undefined, '右键必须打开行菜单');
  assert.match(allText(menu), /打开/);
  assert.match(allText(menu), /配置/);
  assert.ok(
    byClass(menu, 'row-menu-sub').length === 0,
    '「配置」默认收起，不直接铺开管理动作',
  );

  const configBtn = byTag(menu, 'button').find((n) => allText(n).includes('配置'));
  assert.ok(configBtn !== undefined, '必须有「配置」按钮');
  assert.strictEqual(configBtn.props['aria-expanded'], 'false');
  fireEvent.click(configBtn.el);
  await act(async () => {
    await Promise.resolve();
  });

  const opened = byClass(handle.tree(), 'row-menu')[0];
  const sub = byClass(opened, 'row-menu-sub')[0];
  assert.ok(sub !== undefined, '点击「配置」必须展开管理动作分组');
  assert.match(allText(sub), /重命名/);
  assert.match(allText(sub), /复制为副本/);
  assert.match(allText(sub), /删除/);
});
