// 渲染纯函数契约测试（P5.5 / D6）：为 format.ts 与 highlight.ts 的 htm→createElement 改写上护栏。
// 手法与 mount.test.mjs 一致——预置 window 桩 + fakeReact 收集 vnode，不触 DOM、不加载真实 React。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';

/** createElement 桩：产出纯数据 vnode {type, props, children}，不触 DOM。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
};

const noop = () => {};
// deps.js 在模块顶层读 window；先种桩再动态 import 编译产物。
globalThis.window = { React: fakeReact, ReactDOM: {}, addEventListener: noop, removeEventListener: noop };

const { esc, badge, timeOf, emptyState, jsonView, questionView, permChip, todoView, diffView, renderMarkdown } =
  await import('../dist/ui/format.js');
const { highlightCode } = await import('../dist/ui/highlight.js');

/** 展平直接子节点：过滤掉 null/false（React 会忽略）与非元素（纯文本）项。 */
function kids(vnode) {
  if (vnode == null || typeof vnode !== 'object') return [];
  return (vnode.children ?? []).flat(Infinity).filter((c) => c != null && c !== false && typeof c === 'object');
}

/** 取节点的 className。 */
function clsOf(vnode) {
  return typeof vnode?.props?.className === 'string' ? vnode.props.className : '';
}

/** 深度收集元素节点：按先序遍历返回扁平数组。 */
function walk(vnode) {
  if (vnode == null || typeof vnode !== 'object') return [];
  return [vnode, ...kids(vnode).flatMap(walk)];
}

/** 深度收集所有文本子节点（含数组嵌套）。 */
function allText(vnode) {
  if (vnode == null || typeof vnode !== 'object') return vnode == null ? [] : [String(vnode)];
  return (vnode.children ?? []).flat(Infinity).flatMap(allText);
}

test('esc 转义五个 HTML 危险字符，非字符串先归一化', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('badge 命中映射表用中文标签，未命中回退 b-system', () => {
  assert.equal(badge('tool_call').type, 'span');
  assert.equal(clsOf(badge('tool_call')), 'badge b-tool_call');
  assert.deepEqual(allText(badge('tool_call')), ['工具调用']);
  assert.equal(clsOf(badge('不存在的类型')), 'badge b-system');
});

test('timeOf 缺失/非法时间戳返回空串，合法时间戳返回本地时间字符串', () => {
  assert.equal(timeOf(), '');
  assert.equal(timeOf(0), '');
  assert.equal(timeOf(NaN), '');
  assert.equal(typeof timeOf(Date.now()), 'string');
  assert.notEqual(timeOf(Date.now()), '');
});

test('emptyState 产出三段式插画结构', () => {
  const node = emptyState('ICON', '主文案', '副提示');
  assert.equal(clsOf(node), 'empty illu');
  assert.deepEqual(kids(node).map(clsOf), ['illu-icon', 'illu-text', 'illu-hint']);
  assert.deepEqual(allText(node), ['ICON', '主文案', '副提示']);
});

test('jsonView 输出转义后的缩进 JSON', () => {
  const node = jsonView({ a: 1, b: '<x>' });
  assert.equal(node.type, 'pre');
  assert.equal(clsOf(node), 'json');
  const text = allText(node).join('');
  assert.ok(text.includes('&quot;a&quot;: 1'), '键名应被转义');
  assert.ok(text.includes('&lt;x&gt;'), '尖括号应被转义');
});

test('permChip 危险权限追加 danger，普通权限不加', () => {
  const danger = permChip('fs.write');
  assert.equal(clsOf(danger), 'perm danger');
  assert.deepEqual(allText(danger), ['写入文件']);
  assert.equal(danger.props.title, 'fs.write');
  assert.equal(danger.props.key, 'fs.write');
  assert.equal(clsOf(permChip('kv')), 'perm');
  assert.deepEqual(allText(permChip('kv')), ['键值存储']);
  assert.equal(clsOf(permChip('未在表中的权限')), 'perm');
});

test('todoView 按状态给圆点上 done/doing，状态缺失时类名保持带尾空格', () => {
  const node = todoView([
    { status: 'done', content: '已完成' },
    { status: 'doing', content: '进行中' },
    { content: '待开始' },
  ]);
  assert.equal(clsOf(node), 'card');
  const items = kids(node);
  assert.equal(items.length, 3);
  assert.deepEqual(kids(items[0]).map(clsOf), ['todo-dot done', '']);
  assert.deepEqual(kids(items[1]).map(clsOf), ['todo-dot doing', '']);
  assert.deepEqual(kids(items[2]).map(clsOf), ['todo-dot ', '']);
  assert.deepEqual(allText(node), ['已完成', '进行中', '待开始']);
});

test('todoView 必须认得生产者的状态词（completed / in_progress）', () => {
  // 回归（2026-09-26 审计 F8）：生产者（ports/runtime/todo.ts 的 TodoStatus）只发
  // pending|in_progress|completed，而渲染器原先只认 done/doing ⇒ 所有圆点恒为中性灰，
  // 每个待办的进度在 UI 上不可见（旧单测用错词把该 bug 一并钉死）。
  const node = todoView([
    { status: 'completed', content: '已完成' },
    { status: 'in_progress', content: '进行中' },
    { status: 'pending', content: '待开始' },
  ]);
  const items = kids(node);
  assert.deepEqual(kids(items[0]).map(clsOf), ['todo-dot done', '']);
  assert.deepEqual(kids(items[1]).map(clsOf), ['todo-dot doing', '']);
  assert.deepEqual(kids(items[2]).map(clsOf), ['todo-dot ', '']);
});

test('diffView 逐行染 add/del/ctx 且保留原始行首符号', () => {
  const node = diffView('+新增\n-删除\n上下文');
  assert.equal(clsOf(node), 'diff');
  const lines = kids(node);
  assert.deepEqual(lines.map(clsOf), ['add', 'del', 'ctx']);
  assert.deepEqual(allText(node), ['+新增', '-删除', '上下文']);
  assert.deepEqual(
    lines.map((l) => l.props.key),
    ['dl-0', 'dl-1', 'dl-2'],
  );
});

test('questionView 渲染 header/text/options，选项按钮恒 disabled', () => {
  const node = questionView([{ header: '范围', question: '选哪个？', options: [{ label: 'A', description: '说明A' }] }]);
  assert.equal(clsOf(node), 'question-list');
  const item = kids(node)[0];
  assert.equal(clsOf(item), 'question-item');
  assert.deepEqual(kids(item).map(clsOf), ['question-header', 'question-text', 'question-options']);
  const button = kids(kids(item)[2])[0];
  assert.equal(button.type, 'button');
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, '当前环境自动跳过提问');
  assert.deepEqual(kids(button).map(clsOf), ['opt-label', 'opt-desc']);
  // 尾部的 note 恒存在
  assert.equal(clsOf(kids(node).at(-1)), 'question-note');
});

test('questionView 支持非对象提问与无选项场景（不渲染 question-options）', () => {
  const node = questionView('直接一句提问');
  const item = kids(node)[0];
  assert.deepEqual(kids(item).map(clsOf), ['question-text']);
  assert.deepEqual(allText(item), ['直接一句提问']);
});

test('renderMarkdown 空内容产出 md-empty 占位', () => {
  const node = renderMarkdown('');
  assert.equal(clsOf(node), 'md-content md-empty');
  assert.equal(kids(node).length, 0);
});

test('renderMarkdown 标题下移两级（h1→h3）且列表/表格结构完整', () => {
  const node = renderMarkdown('# 标题\n\n- 甲\n- 乙\n\n|列1|列2|\n|-|-|\n|a|b|\n');
  assert.equal(clsOf(node), 'md-content');
  const blocks = kids(node);
  assert.equal(blocks[0].type, 'h3');
  assert.equal(clsOf(blocks[0]), 'md-h1');
  assert.equal(blocks[1].type, 'ul');
  assert.deepEqual(kids(blocks[1]).map((li) => allText(li).join('')), ['甲', '乙']);
  const table = blocks[2];
  assert.equal(table.type, 'table');
  assert.deepEqual(walk(table).filter((n) => n.type === 'th').map((n) => allText(n).join('')), ['列1', '列2']);
  assert.deepEqual(walk(table).filter((n) => n.type === 'td').map((n) => allText(n).join('')), ['a', 'b']);
});

test('renderMarkdown 代码块包 .md-codeblock 且含语言标签与复制按钮', () => {
  const node = renderMarkdown('```ts\nconst a = 1;\n```');
  assert.equal(clsOf(node), 'md-content');
  const blocks = walk(node).filter((n) => clsOf(n) === 'md-codeblock');
  assert.equal(blocks.length, 1, '应有一个代码块容器');
  const c = blocks[0];
  const bars = kids(c).filter((k) => clsOf(k) === 'md-codeblock__bar');
  assert.equal(bars.length, 1, '应有工具条');
  const btn = walk(c).find((n) => clsOf(n) === 'md-codeblock__copy');
  assert.ok(btn, '应有复制按钮');
  assert.equal(btn.type, 'button');
  assert.deepEqual(allText(btn), ['复制']);
  const lang = walk(c).find((n) => clsOf(n) === 'md-codeblock__lang');
  assert.ok(lang, '应有语言标签');
  assert.deepEqual(allText(lang), ['ts']);
  const pre = walk(c).find((n) => n.type === 'pre');
  assert.ok(pre, '应有 pre');
  assert.deepEqual(allText(pre).join(''), 'const a = 1;');
});

test('highlightCode 空源码返回 null', () => {
  assert.equal(highlightCode('', 'ts'), null);
});

test('highlightCode 产出 pre>code 且 token 类型为 span', () => {
  const node = highlightCode('const a = 1;', 'ts');
  assert.equal(node.type, 'pre');
  assert.equal(clsOf(node), 'hl-code hl-ts');
  const code = kids(node)[0];
  assert.equal(code.type, 'code');
  assert.ok(kids(code).length > 0, '应有 token span');
  assert.ok(kids(code).every((s) => s.type === 'span'));
});

test('highlightCode 保留 markdown 行尾换行（回归护栏：htm 曾丢弃纯空白文本节点）', () => {
  const node = highlightCode('# 标题\n正文\n', 'md');
  const code = kids(node)[0];
  const newlines = kids(code).filter((s) => allText(s).includes('\n'));
  assert.equal(newlines.length, 3, '三行源码应各保留一个换行 token');
  assert.ok(allText(code).join('').includes('\n'), '整段文本必须仍能拼出换行');
});
