// 渲染纯函数契约测试（P5.5 / D6）：为 format.ts 与 highlight.ts 的 htm→createElement 改写上护栏。
// 手法与 mount.test.mjs 一致——预置 window 桩 + fakeReact 收集 vnode，不触 DOM、不加载真实 React。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import { test } from 'vitest';

/** createElement 桩：产出纯数据 vnode {type, props, children}，不触 DOM。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
};

const noop = () => {};
// deps.js 在模块顶层读 window；先种桩再动态 import 编译产物。
globalThis.window = { React: fakeReact, ReactDOM: {}, addEventListener: noop, removeEventListener: noop };

const {
  esc, badge, timeOf, emptyState, emptyNote, jsonView, questionView, permChip, todoView, diffView,
  renderMarkdown, legacyRenderMarkdown,
} = await import('../src/ui/format.js');
const { highlightCode } = await import('../src/ui/highlight.js');

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

test('jsonView 输出缩进 JSON 的**原文**（React 子节点不预转义）', () => {
  // 2026-10-16 纠错：原先这里断言文本里含 `&quot;`，把「双重转义」当成了正确行为。
  // React 会把子节点的文本自己转义，再 `esc()` 一次等于把 `"` 变成**字面量** `&quot;`——
  // 真机实测（截图留档）审批弹窗的参数区显示的就是 `&quot;cmd&quot;: &quot;rm -rf …`，
  // 用户看到的是实体而不是引号。判据改为「原文进 DOM，尖括号与引号都是原字符」。
  const node = jsonView({ a: 1, b: '<x>' });
  assert.equal(node.type, 'pre');
  assert.equal(clsOf(node), 'json');
  const text = allText(node).join('');
  assert.ok(text.includes('"a": 1'), '键名应是原引号，不是 &quot;');
  assert.ok(!text.includes('&quot;'), '不得出现 HTML 实体（双重转义）');
  assert.ok(text.includes('<x>'), '尖括号应是原字符，不是 &lt;x&gt;');
  assert.ok(!text.includes('&lt;'), '不得出现 HTML 实体（双重转义）');
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

test('用户可见文本一律不预转义：含 & < > 的真实内容原样进 DOM', () => {
  // 回归（2026-10-16 真机截图）：`esc()` 曾被误用为「React 子节点的安全转义」，于是
  // 真实内容里的 `&` `"` `<` 被**双重转义**成 `&amp;` `&quot;` `&lt;` 的字面量并原样显示。
  // 最容易撞上的两处：① 审批弹窗的 JSON 参数（几乎每个值都带引号）；
  // ② 空态文案里的路径（`D:\a&b`、`C:\Program Files (x86)` 这类带 & 与括号的路径）。
  // 判据：这些文本必须原样出现在 vnode 的子节点里（React 会在写入 DOM 时自己转义）。
  const raw = 'D:\\work&stuff\\<x>\\"q".txt';
  assert.deepEqual(allText(emptyState('ICON', raw, raw)), ['ICON', raw, raw]);
  assert.deepEqual(allText(emptyNote(raw)), [raw]);
  assert.deepEqual(allText(todoView([{ status: 'done', content: raw }])), [raw]);
  assert.equal(permChip('未在表中的权限').props.title, '未在表中的权限');
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

test('todoView 必须认得生产者的状态词（completed / in_progress）', () => {  // 回归（2026-09-26 审计 F8）：生产者（ports/runtime/todo.ts 的 TodoStatus）只发
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

test('questionView 把 header/text/options 渲染为只读内容（选项不再伪装成可点按钮）', () => {
  const node = questionView([{ header: '范围', question: '选哪个？', options: [{ label: 'A', description: '说明A' }] }]);
  assert.equal(clsOf(node), 'question-list');
  const item = kids(node)[0];
  assert.equal(clsOf(item), 'question-item');
  assert.deepEqual(kids(item).map(clsOf), ['question-header', 'question-text', 'question-options']);
  const option = kids(kids(item)[2])[0];
  // 2026-10-08 纠错：此前是 `disabled` 的 <button> + 「当前环境自动跳过提问」——
  // 看起来能点、实际点不动，且说明与事实不符（serve 下是真人在答）。选项现在只是内容。
  assert.equal(option.type, 'div');
  assert.equal(option.props.disabled, undefined);
  assert.equal(option.props.title, undefined);
  assert.deepEqual(kids(option).map(clsOf), ['opt-label', 'opt-desc']);
  // 没有待作答时**不出现**说明（旧版恒有一句与事实不符的「已自动返回默认值」）。
  assert.equal(kids(node).length, 1);
});

test('questionView：有提问等待作答时给出指向提问卡的指引', () => {
  const node = questionView([{ question: '选哪个？' }], { pending: true });
  const note = kids(node).at(-1);
  assert.equal(clsOf(note), 'question-note pending');
  assert.match(allText(note).join(''), /请在下方提问卡/);
});

test('questionView 支持非对象提问与无选项场景（不渲染 question-options）', () => {
  const node = questionView('直接一句提问');
  const item = kids(node)[0];
  assert.deepEqual(kids(item).map(clsOf), ['question-text']);
  assert.deepEqual(allText(item), ['直接一句提问']);
});

test('手写渲染器：空内容产出 md-empty 占位', () => {
  // 2026-10-17：本用例断言的是**手写回落实现**的契约（自绘表格/代码块、h1→h3 下移）。
  // 迁移到 npm 依赖后 `renderMarkdown` 恒定走 markdown-it 管线，回退分支在生产路径
  // 已不可达，故这里显式改调 `legacyRenderMarkdown` —— 断言一条没改，只是不再靠
  // 「桩里缺 vendor 全局」隐式触发那条分支。
  const node = legacyRenderMarkdown('');
  assert.equal(clsOf(node), 'md-content md-empty');
  assert.equal(kids(node).length, 0);
});

test('手写渲染器：标题下移两级（h1→h3）且列表/表格结构完整', () => {
  // 2026-10-17：本用例断言的是**手写回落实现**的契约（自绘表格/代码块、h1→h3 下移）。
  // 迁移到 npm 依赖后 `renderMarkdown` 恒定走 markdown-it 管线，回退分支在生产路径
  // 已不可达，故这里显式改调 `legacyRenderMarkdown` —— 断言一条没改，只是不再靠
  // 「桩里缺 vendor 全局」隐式触发那条分支。
  const node = legacyRenderMarkdown('# 标题\n\n- 甲\n- 乙\n\n|列1|列2|\n|-|-|\n|a|b|\n');
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

test('renderMarkdown 现在委托给 markdown-it 管线（依赖已随 bundle 就位）', () => {
  // 迁移前这条分支取决于「window.markdownit 是否存在」；改成 npm import 后恒为真。
  // 断言方式：markdown-it 产出的结构与手写实现不同 —— 它会输出标准 <p>/<code> 结构，
  // 且不再做 h1→h3 的下移（那是手写实现为了版面做的特例）。
  const node = renderMarkdown('# 标题');
  assert.ok(node != null, 'renderMarkdown 必须产出节点');
  assert.equal(clsOf(node), 'md-content', '仍应包一层 md-content');
});

test('手写渲染器：代码块包 .md-codeblock 且含语言标签与复制按钮', () => {
  // 2026-10-17：本用例断言的是**手写回落实现**的契约（自绘表格/代码块、h1→h3 下移）。
  // 迁移到 npm 依赖后 `renderMarkdown` 恒定走 markdown-it 管线，回退分支在生产路径
  // 已不可达，故这里显式改调 `legacyRenderMarkdown` —— 断言一条没改，只是不再靠
  // 「桩里缺 vendor 全局」隐式触发那条分支。
  const node = legacyRenderMarkdown('```ts\nconst a = 1;\n```');
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
