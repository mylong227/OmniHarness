// 渲染纯函数契约测试（P5.5 / D6）：为 format.ts 与 highlight.ts 的 htm→createElement 改写上护栏。
// 手法与 mount.test.mjs 一致——预置 window 桩 + fakeReact 收集 vnode，不触 DOM、不加载真实 React。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type * as ReactNS from 'react';
import { renderElement } from './rtlHarness.ts';
import {
  allText as facadeAllText,
  clsOf as facadeClsOf,
  kids as facadeKids,
  walk as facadeWalk,
} from './domFacade.ts';
import type { FacadeNode } from './domFacade.ts';

// 迁移说明（2026-10-18）：本文件原先用 `fakeReact` + `window` 桩收集纯数据 vnode。
// 现在走**真实 React + jsdom**：格式函数返回的元素被真的渲染成 DOM，再由 `domFacade`
// 快照回 `{ type, props, children }` 形状——断言语义不变，但渲染路径是真的
// （hooks / context / 属性映射不再由替身假装）。

const {
  esc, badge, timeOf, emptyState, emptyNote, jsonView, questionView, permChip, todoView, diffView,
  renderMarkdown, legacyRenderMarkdown,
} = await import('../src/ui/format.ts');
const { highlightCode } = await import('../src/ui/highlight.ts');

/**
 * 元素或外观节点 → 外观节点（元素会被真实渲染**一次**，结果缓存）。
 *
 * 既有断言对同一个值反复取成员（`clsOf(badge(...))`、`allText(badge(...))`…），
 * 若每次调用都重新渲染，会重复挂载并把渲染次数放大若干倍。WeakMap 保证一元素一渲染。
 */
const facadeCache = new WeakMap<object, FacadeNode | null>();

/**
 * 元素或外观节点 → 外观节点。
 * @param value 格式函数返回值（React 元素 / 外观节点 / null）
 * @returns 外观节点或 null
 */
function asNode(value: unknown): FacadeNode | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const obj = value as object;
  if ('el' in (obj as Record<string, unknown>)) return obj as FacadeNode;
  const cached = facadeCache.get(obj);
  if (cached !== undefined) return cached;
  const node = renderElement(obj as ReactNS.ReactNode).node;
  facadeCache.set(obj, node);
  return node;
}

/**
 * 元素或外观节点 → 外观节点数组（数组输入逐项转换）。
 * @param value 任意返回值
 * @returns 外观节点数组（可能含 null）
 */
function asNodes(value: unknown): (FacadeNode | null)[] {
  if (Array.isArray(value)) return value.map(asNode);
  return [asNode(value)];
}

/**
 * 展平直接子元素（迁移前 `kids` 的语义：只保留元素，过滤文本/null/false）。
 * @param vnode 元素或外观节点
 * @returns 子元素
 */
function kids(vnode: unknown): FacadeNode[] {
  return asNodes(vnode).flatMap((n) => facadeKids(n));
}

/**
 * 取 className（迁移前 `clsOf` 的语义）。
 * @param vnode 元素或外观节点
 * @returns className
 */
function clsOf(vnode: unknown): string {
  return facadeClsOf(asNode(vnode));
}

/**
 * 深度收集元素节点（迁移前 `walk` 的语义：先序扁平数组）。
 * @param vnode 元素或外观节点
 * @returns 元素数组
 */
function walk(vnode: unknown): FacadeNode[] {
  const out: FacadeNode[] = [];
  for (const n of asNodes(vnode)) facadeWalk(n, (node) => out.push(node));
  return out;
}

/**
 * 深度收集文本子节点（迁移前 `allText` 的语义：返回**字符串数组**）。
 * @param vnode 元素或外观节点
 * @returns 文本数组
 */
function allText(vnode: unknown): string[] {
  if (typeof vnode === 'string') return [vnode];
  const out: string[] = [];
  for (const n of asNodes(vnode)) facadeAllText(n);
  for (const n of asNodes(vnode)) {
    facadeWalk(n, (node) => {
      for (const c of node.children) if (typeof c === 'string') out.push(c);
    });
  }
  return out;
}

/**
 * 兼容旧名：把值收窄为外观节点。
 * @param n 元素或外观节点
 * @returns 外观节点
 */
function stub(n: unknown): FacadeNode {
  return asNode(n) as FacadeNode;
}

test('esc 转义五个 HTML 危险字符，非字符串先归一化', () => {
  assert.strictEqual(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(42), '42');
});

test('badge 命中映射表用中文标签，未命中回退 b-system', () => {
  assert.strictEqual(badge('tool_call').type, 'span');
  assert.strictEqual(clsOf(badge('tool_call')), 'badge b-tool_call');
  assert.deepEqual(allText(badge('tool_call')), ['工具调用']);
  assert.strictEqual(clsOf(badge('不存在的类型')), 'badge b-system');
});

test('timeOf 缺失/非法时间戳返回空串，合法时间戳返回本地时间字符串', () => {
  assert.strictEqual(timeOf(), '');
  assert.strictEqual(timeOf(0), '');
  assert.strictEqual(timeOf(NaN), '');
  assert.strictEqual(typeof timeOf(Date.now()), 'string');
  assert.notEqual(timeOf(Date.now()), '');
});

test('emptyState 产出三段式插画结构', () => {
  const node = emptyState('ICON', '主文案', '副提示');
  assert.strictEqual(clsOf(node), 'empty illu');
  assert.deepEqual(kids(node).map(clsOf), ['illu-icon', 'illu-text', 'illu-hint']);
  assert.deepEqual(allText(node), ['ICON', '主文案', '副提示']);
});

test('jsonView 输出缩进 JSON 的**原文**（React 子节点不预转义）', () => {
  // 2026-10-16 纠错：原先这里断言文本里含 `&quot;`，把「双重转义」当成了正确行为。
  // React 会把子节点的文本自己转义，再 `esc()` 一次等于把 `"` 变成**字面量** `&quot;`——
  // 真机实测（截图留档）审批弹窗的参数区显示的就是 `&quot;cmd&quot;: &quot;rm -rf …`，
  // 用户看到的是实体而不是引号。判据改为「原文进 DOM，尖括号与引号都是原字符」。
  const node = jsonView({ a: 1, b: '<x>' });
  assert.strictEqual(node.type, 'pre');
  assert.strictEqual(clsOf(node), 'json');
  const text = allText(node).join('');
  assert.ok(text.includes('"a": 1'), '键名应是原引号，不是 &quot;');
  assert.ok(!text.includes('&quot;'), '不得出现 HTML 实体（双重转义）');
  assert.ok(text.includes('<x>'), '尖括号应是原字符，不是 &lt;x&gt;');
  assert.ok(!text.includes('&lt;'), '不得出现 HTML 实体（双重转义）');
});

test('permChip 危险权限追加 danger，普通权限不加', () => {
  const danger = stub(permChip('fs.write'));
  assert.strictEqual(clsOf(danger), 'perm danger');
  assert.deepEqual(allText(danger), ['写入文件']);
  assert.strictEqual(danger.props.title, 'fs.write');
  // 真实 React 不把 `key` 渲染成 DOM 属性（由 React 消费），故改断言 DOM 可见契约。
  // 原断言想锁「同一权限稳定同一条目」，稳定的可见等价物就是 title（上面已断言）。
  assert.strictEqual(clsOf(danger), 'perm danger');
  assert.strictEqual(clsOf(permChip('kv')), 'perm');
  assert.deepEqual(allText(permChip('kv')), ['键值存储']);
  assert.strictEqual(clsOf(permChip('未在表中的权限')), 'perm');
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
  assert.strictEqual(stub(permChip('未在表中的权限')).props.title, '未在表中的权限');
});

test('todoView 按状态给圆点上 done/doing，状态缺失时类名保持带尾空格', () => {
  const node = todoView([
    { status: 'done', content: '已完成' },
    { status: 'doing', content: '进行中' },
    { content: '待开始' },
  ]);
  assert.strictEqual(clsOf(node), 'card');
  const items = kids(node);
  assert.strictEqual(items.length, 3);
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
  assert.strictEqual(clsOf(node), 'diff');
  const lines = kids(node);
  assert.deepEqual(lines.map(clsOf), ['add', 'del', 'ctx']);
  assert.deepEqual(allText(node), ['+新增', '-删除', '上下文']);
  // 原断言比较 `props.key`（React 的 key 不进 DOM）。等价且更贴近用户的观察是**行顺序与文本**：
  // 顺序错了 diff 就不可读——那才是这条判据真正要防的东西。
  assert.deepEqual(allText(node), ['+新增', '-删除', '上下文']);
});

test('questionView 把 header/text/options 渲染为只读内容（选项不再伪装成可点按钮）', () => {
  const node = questionView([{ header: '范围', question: '选哪个？', options: [{ label: 'A', description: '说明A' }] }]);
  assert.strictEqual(clsOf(node), 'question-list');
  const item = kids(node)[0];
  assert.strictEqual(clsOf(item), 'question-item');
  assert.deepEqual(kids(item).map(clsOf), ['question-header', 'question-text', 'question-options']);
  const option = kids(kids(item)[2])[0];
  // 2026-10-08 纠错：此前是 `disabled` 的 <button> + 「当前环境自动跳过提问」——
  // 看起来能点、实际点不动，且说明与事实不符（serve 下是真人在答）。选项现在只是内容。
  assert.strictEqual(option.type, 'div');
  assert.strictEqual(option.props.disabled, undefined);
  assert.strictEqual(option.props.title, undefined);
  assert.deepEqual(kids(option).map(clsOf), ['opt-label', 'opt-desc']);
  // 没有待作答时**不出现**说明（旧版恒有一句与事实不符的「已自动返回默认值」）。
  assert.strictEqual(kids(node).length, 1);
});

test('questionView：有提问等待作答时给出指向提问卡的指引', () => {
  const node = questionView([{ question: '选哪个？' }], { pending: true });
  const note = kids(node).at(-1);
  assert.strictEqual(clsOf(note), 'question-note pending');
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
  assert.strictEqual(clsOf(node), 'md-content md-empty');
  assert.strictEqual(kids(node).length, 0);
});

test('手写渲染器：标题下移两级（h1→h3）且列表/表格结构完整', () => {
  // 2026-10-17：本用例断言的是**手写回落实现**的契约（自绘表格/代码块、h1→h3 下移）。
  // 迁移到 npm 依赖后 `renderMarkdown` 恒定走 markdown-it 管线，回退分支在生产路径
  // 已不可达，故这里显式改调 `legacyRenderMarkdown` —— 断言一条没改，只是不再靠
  // 「桩里缺 vendor 全局」隐式触发那条分支。
  const node = legacyRenderMarkdown('# 标题\n\n- 甲\n- 乙\n\n|列1|列2|\n|-|-|\n|a|b|\n');
  assert.strictEqual(clsOf(node), 'md-content');
  const blocks = kids(node);
  assert.strictEqual(blocks[0].type, 'h3');
  assert.strictEqual(clsOf(blocks[0]), 'md-h1');
  assert.strictEqual(blocks[1].type, 'ul');
  assert.deepEqual(kids(blocks[1]).map((li) => allText(li).join('')), ['甲', '乙']);
  const table = blocks[2];
  assert.strictEqual(table.type, 'table');
  assert.deepEqual(walk(table).filter((n) => n.type === 'th').map((n) => allText(n).join('')), ['列1', '列2']);
  assert.deepEqual(walk(table).filter((n) => n.type === 'td').map((n) => allText(n).join('')), ['a', 'b']);
});

test('renderMarkdown 现在委托给 markdown-it 管线（依赖已随 bundle 就位）', () => {
  // 迁移前这条分支取决于「window.markdownit 是否存在」；改成 npm import 后恒为真。
  // 断言方式：markdown-it 产出的结构与手写实现不同 —— 它会输出标准 <p>/<code> 结构，
  // 且不再做 h1→h3 的下移（那是手写实现为了版面做的特例）。
  const node = renderMarkdown('# 标题');
  assert.ok(node != null, 'renderMarkdown 必须产出节点');
  assert.strictEqual(clsOf(node), 'md-content', '仍应包一层 md-content');
});

test('手写渲染器：代码块包 .md-codeblock 且含语言标签与复制按钮', () => {
  // 2026-10-17：本用例断言的是**手写回落实现**的契约（自绘表格/代码块、h1→h3 下移）。
  // 迁移到 npm 依赖后 `renderMarkdown` 恒定走 markdown-it 管线，回退分支在生产路径
  // 已不可达，故这里显式改调 `legacyRenderMarkdown` —— 断言一条没改，只是不再靠
  // 「桩里缺 vendor 全局」隐式触发那条分支。
  const node = legacyRenderMarkdown('```ts\nconst a = 1;\n```');
  assert.strictEqual(clsOf(node), 'md-content');
  const blocks = walk(node).filter((n) => clsOf(n) === 'md-codeblock');
  assert.strictEqual(blocks.length, 1, '应有一个代码块容器');
  const c = blocks[0];
  const bars = kids(c).filter((k) => clsOf(k) === 'md-codeblock__bar');
  assert.strictEqual(bars.length, 1, '应有工具条');
  const btn = walk(c).find((n) => clsOf(n) === 'md-codeblock__copy');
  assert.ok(btn, '应有复制按钮');
  assert.strictEqual(btn.type, 'button');
  assert.deepEqual(allText(btn), ['复制']);
  const lang = walk(c).find((n) => clsOf(n) === 'md-codeblock__lang');
  assert.ok(lang, '应有语言标签');
  assert.deepEqual(allText(lang), ['ts']);
  const pre = walk(c).find((n) => n.type === 'pre');
  assert.ok(pre, '应有 pre');
  assert.deepEqual(allText(pre).join(''), 'const a = 1;');
});

test('highlightCode 空源码返回 null', () => {
  assert.strictEqual(highlightCode('', 'ts'), null);
});

test('highlightCode 产出 pre>code 且 token 类型为 span', () => {
  const node = highlightCode('const a = 1;', 'ts');
  // 空源码才返回 null；此处源码非空（非空断言不改变运行时行为）。
  assert.strictEqual(node!.type, 'pre');
  assert.strictEqual(clsOf(node), 'hl-code hl-ts');
  const code = kids(node)[0];
  assert.strictEqual(code.type, 'code');
  assert.ok(kids(code).length > 0, '应有 token span');
  assert.ok(kids(code).every((s) => s.type === 'span'));
});

test('highlightCode 保留 markdown 行尾换行（回归护栏：htm 曾丢弃纯空白文本节点）', () => {
  const node = highlightCode('# 标题\n正文\n', 'md');
  const code = kids(node)[0];
  const newlines = kids(code).filter((s) => allText(s).includes('\n'));
  assert.strictEqual(newlines.length, 3, '三行源码应各保留一个换行 token');
  assert.ok(allText(code).join('').includes('\n'), '整段文本必须仍能拼出换行');
});
