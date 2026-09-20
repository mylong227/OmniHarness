// 会话搜索升级（A3）：服务端 search.all 的分组/确定性排序/高亮，以及 ↑↓/Enter 与「无输入不打远端」。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。
//
// 关键口径：
//   · 确定性：把同一批命中打乱顺序喂进去，输出必须逐项一致（同输入恒同序）；
//   · 无输入不打远端：用桩 api 记录调用次数，空/纯空白关键字必须 0 次；
//   · 组件层用 scheduleSearch 注入「同步执行」的调度器，把防抖变成可断言行为（而不是等 220ms 碰运气）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();
const { SearchHitGrouper } = await import('../dist/ui/models/SearchHitGrouper.js');
const { SessionSearch } = await import('../dist/ui/models/SessionSearch.js');
const { SessionPanel } = await import('../dist/ui/components/SessionPanel.js');
const { SearchResults } = await import('../dist/ui/components/SearchResults.js');

/** 会话命中（故意乱序，用于验证排序确实由前端定序）。 */
const CHATS = [
  { kind: 'chat', id: 's-2', label: '重构 app 启动', hint: '2026-09-19T10:00:00Z' },
  { kind: 'chat', id: 's-1', label: 'app 图标', hint: '2026-09-18T10:00:00Z' },
];
/** 文件命中（故意乱序 + 长路径，验证「基名命中优先、短标签优先、id 兜底」）。 */
const FILES = [
  { kind: 'file', id: 'web/src/ui/App.tsx', label: 'App.tsx', hint: 'web/src/ui' },
  { kind: 'file', id: 'src/app.ts', label: 'app.ts', hint: 'src' },
];

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
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

/** 收集整棵树的文本叶子。 */
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

/** 手写调度器：把防抖回调攒起来，由测试显式 flush（确定性，不依赖真实定时器）。 */
function manualScheduler() {
  const queue = [];
  return {
    schedule(fn) {
      queue.push(fn);
      return queue.length;
    },
    cancel(handle) {
      queue[handle - 1] = null;
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
  const hits = [
    { kind: 'file', id: 'x/a-long-name-app.ts', label: 'a-long-name-app.ts', hint: 'x' },
    { kind: 'file', id: 'y/app.ts', label: 'app.ts', hint: 'y' },
  ];
  const sorted = SearchHitGrouper.sort(hits, 'app');
  assert.strictEqual(sorted[0].id, 'y/app.ts', '位置 0 的命中优先');
});

test('SearchHitGrouper.sort：完全并列时用 id 兜底（总序，绝不出现不稳定顺序）', () => {
  const hits = [
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

  const many = Array.from({ length: 30 }, (_, i) => ({
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
  const calls = [];
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
  assert.strictEqual(s.selected().id, 's-1');
});

test('SessionSearch：陈旧响应不得覆盖新结果（防乱序回跳）', async () => {
  const resolvers = [];
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
  assert.strictEqual(s.selected().id, 'new');
  resolvers[0].resolve({
    files: [],
    chats: [{ kind: 'chat', id: 'stale', label: 'first', hint: '' }],
  });
  await flush();
  assert.strictEqual(s.selected().id, 'new', '先发后到的旧结果必须被丢弃');
});

test('SessionSearch：清空关键字即丢弃在途响应与结果', async () => {
  const resolvers = [];
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

/** 渲染一次 SessionPanel（槽位跨渲染保持，故无 seed 时沿用上一次状态）。 */
function renderPanel(props, seed) {
  return runtime.render(SessionPanel, props, seed);
}

/** 找到搜索输入框。 */
function searchInput(vnode) {
  return collect(vnode, (n) => n.props.className === 'session-search')[0];
}

/**
 * 装配 SessionPanel 桩环境。
 * @returns 渲染/调用记录句柄
 */
function setupPanel() {
  const calls = { searchAll: [], opened: [], selected: [] };
  runtime.appContext.api = {
    async searchAll(q) {
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
  runtime.appContext.toast = () => {};
  const props = {
    sessions: [
      { id: 's-1', label: 'app 图标', workspace: '' },
      { id: 's-9', label: '无关会话', workspace: '' },
    ],
    currentThreadId: 's-1',
    onSelect: (id) => calls.selected.push(id),
    onNew: () => {},
    onOpenFile: (p) => calls.opened.push(p),
    onRename: () => {},
    onDelete: () => {},
    onFork: () => {},
    open: true,
    style: {},
    // 同步调度：把防抖变成「调用即执行」，测试无需等真实定时器。
    scheduleSearch: (fn) => {
      fn();
      return 0;
    },
  };
  runtime.reset();
  const vnode = renderPanel(props);
  return { vnode, calls, props };
}

test('SessionPanel：无输入（含纯空白）时一次远端搜索都不发', async () => {
  const { vnode, calls, props } = setupPanel();
  const input = searchInput(vnode);
  assert.ok(input, '必须渲染搜索框');
  assert.strictEqual(input.props.role, 'combobox');
  assert.strictEqual(input.props['aria-expanded'], 'false', '无关键字时不展开结果');
  input.props.onChange({ target: { value: '' } });
  input.props.onChange({ target: { value: '   ' } });
  await flush();
  assert.deepStrictEqual(calls.searchAll, [], '空关键字不得打远端');
  assert.strictEqual(renderPanel(props) && calls.searchAll.length, 0);
});

/** 是否为带某 class 的元素（按空格切分，避免 `session` 命中 `session-toolbar`）。 */
function hasClass(node, name) {
  return typeof node.props.className === 'string' && node.props.className.split(' ').includes(name);
}

test('SessionPanel：有关键字即打 search.all，并把分组结果交给 SearchResults', async () => {
  const { vnode, calls, props } = setupPanel();
  searchInput(vnode).props.onChange({ target: { value: 'app' } });
  await flush();
  assert.deepStrictEqual(calls.searchAll, ['app'], '有输入必须打一次远端搜索');

  const next = renderPanel(props);
  const sr = collect(next, (n) => n.type === SearchResults);
  assert.strictEqual(sr.length, 1, '必须渲染搜索结果视图');
  assert.deepStrictEqual(
    sr[0].props.groups.map((g) => g.kind),
    ['chat', 'file'],
    '会话组在前、文件组在后',
  );
  assert.strictEqual(sr[0].props.selectedIndex, 0, '结果到达即选中首项');
  assert.strictEqual(sr[0].props.query, 'app');
  assert.strictEqual(sr[0].props.loading, false);

  const input = searchInput(next);
  assert.strictEqual(input.props['aria-expanded'], 'true');
  assert.strictEqual(input.props['aria-controls'], 'session-search-results');
  assert.strictEqual(input.props['aria-activedescendant'], 'sr-opt-0');
  assert.strictEqual(input.props['aria-autocomplete'], 'list');
});

test('SearchResults：listbox/option 语义 + aria-selected + 命中高亮 + 条数播报', () => {
  const picked = [];
  const groups = SearchHitGrouper.group(FILES, CHATS, 'app');
  const vnode = runtime.render(SearchResults, {
    groups,
    selectedIndex: 0,
    query: 'app',
    loading: false,
    onPick: (hit) => picked.push(hit),
  });
  const options = collect(vnode, (n) => n.props.role === 'option');
  assert.strictEqual(options.length, 4, '会话 2 + 文件 2');
  assert.deepStrictEqual(
    options.map((o) => o.props.id),
    ['sr-opt-0', 'sr-opt-1', 'sr-opt-2', 'sr-opt-3'],
  );
  assert.deepStrictEqual(
    options.map((o) => o.props['aria-selected']),
    ['true', 'false', 'false', 'false'],
  );
  const listbox = collect(vnode, (n) => n.props.role === 'listbox');
  assert.strictEqual(listbox.length, 1);
  assert.strictEqual(listbox[0].props.id, 'session-search-results');
  assert.deepStrictEqual(
    collect(vnode, (n) => n.props.role === 'group').map((g) => g.props['aria-label']),
    ['会话', '工作区文件'],
  );
  const marks = collect(vnode, (n) => n.type === 'mark');
  assert.ok(marks.length >= 4, '命中片段必须用 mark 高亮（实际 ' + String(marks.length) + ' 处）');
  assert.ok(
    texts(vnode).some((t) => t.includes('找到 4 条结果')),
    '必须播报结果条数',
  );
  const status = collect(vnode, (n) => n.props.role === 'status')[0];
  assert.strictEqual(status.props['aria-live'], 'polite');

  // 点击走的是 onMouseDown（避免 blur 丢焦点）：必须回传被点中的那一条。
  options[2].props.onMouseDown({ preventDefault() {} });
  assert.deepStrictEqual(picked, [
    { kind: 'file', id: 'src/app.ts', label: 'app.ts', hint: 'src' },
  ]);
});

test('SearchResults：无关键字整块不渲染（空间还给本地会话列表）', () => {
  const vnode = runtime.render(SearchResults, {
    groups: [],
    selectedIndex: -1,
    query: '   ',
    loading: false,
    onPick: () => {},
  });
  assert.strictEqual(vnode, null);
});

test('SessionPanel：本地即时过滤保留（无输入也生效，且与远端结果无关）', () => {
  const { props } = setupPanel();
  // 关键字由 hook 槽位（9=query）注入：模拟「输入 app 但远端尚未回」的本地过滤态。
  const vnode = renderPanel(props, { 9: 'app' });
  const rows = collect(vnode, (n) => hasClass(n, 'session'));
  assert.strictEqual(rows.length, 1, '本地过滤必须只留下匹配会话');
  const other = renderPanel(props, { 9: 'zzz' });
  assert.ok(
    texts(other).some((t) => t.includes('暂无会话')),
    '无匹配时必须落到空态文案',
  );
});

test('SessionPanel：↑/↓ 移动选中、Enter 打开会话、再 Enter 打开文件', async () => {
  const { vnode, calls, props } = setupPanel();
  searchInput(vnode).props.onChange({ target: { value: 'app' } });
  await flush();

  let next = renderPanel(props);
  const down = () => searchInput(next).props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  const up = () => searchInput(next).props.onKeyDown({ key: 'ArrowUp', preventDefault() {} });
  const enter = () => searchInput(next).props.onKeyDown({ key: 'Enter', preventDefault() {} });

  up();
  next = renderPanel(props);
  assert.strictEqual(
    searchInput(next).props['aria-activedescendant'],
    'sr-opt-0',
    '首项再按 ↑ 夹取',
  );

  down();
  next = renderPanel(props);
  assert.strictEqual(searchInput(next).props['aria-activedescendant'], 'sr-opt-1');

  enter();
  await flush();
  assert.deepStrictEqual(calls.selected, ['s-2'], 'Enter 打开的是当前选中的会话（第 2 项）');
  assert.deepStrictEqual(calls.opened, []);
  assert.deepStrictEqual(calls.searchAll, ['app'], '打开后清空关键字不得再打远端');

  // 重新搜索 → 下移到第一个文件命中 → Enter 走文件预览
  next = renderPanel(props);
  searchInput(next).props.onChange({ target: { value: 'app' } });
  await flush();
  next = renderPanel(props);
  searchInput(next).props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  next = renderPanel(props);
  searchInput(next).props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  next = renderPanel(props);
  assert.strictEqual(searchInput(next).props['aria-activedescendant'], 'sr-opt-2');
  searchInput(next).props.onKeyDown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.deepStrictEqual(calls.opened, ['src/app.ts'], '文件命中 Enter 必须在右侧预览');
});

test('SessionPanel：Esc 清空关键字并收起结果（不再打远端）', async () => {
  const { vnode, calls, props } = setupPanel();
  searchInput(vnode).props.onChange({ target: { value: 'app' } });
  await flush();
  let next = renderPanel(props);
  assert.strictEqual(collect(next, (n) => n.type === SearchResults).length, 1);
  searchInput(next).props.onKeyDown({ key: 'Escape', preventDefault() {} });
  next = renderPanel(props);
  const sr = collect(next, (n) => n.type === SearchResults)[0];
  assert.strictEqual(sr.props.query, '', 'Esc 必须清空关键字');
  assert.deepStrictEqual(sr.props.groups, [], 'Esc 必须收起结果');
  assert.strictEqual(searchInput(next).props['aria-expanded'], 'false');
  assert.deepStrictEqual(calls.searchAll, ['app'], 'Esc 后不得补打远端');
});
