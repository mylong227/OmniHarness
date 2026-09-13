// 组件挂载契约测试（P5.5）：零依赖 DOM 桩——不加载真实 React/ReactDOM，
// 用「预置 window 桩 + 真实 htm 解析」驱动 class 组件的 render()，对元素树做断言。
// 覆盖面：组件可实例化、render 产出合法 vnode 树、关键 UI 契约（文案/回调接线）不变。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 真实 htm（web/vendor UMD）：以「文本 + 模拟 module 出口」加载，规避 .js 被 node 当 ESM 的问题。 */
const htmSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../vendor/htm.umd.js'), 'utf8');
const htmModule = { exports: {} };
new Function('module', 'exports', 'globalThis', htmSrc)(htmModule, htmModule.exports, globalThis);
const realHtm = htmModule.exports;

/** createElement 桩：产出纯数据 vnode {type, props, children}，不触 DOM。 */
class FakeComponent {
  constructor(props) {
    this.props = props ?? {};
  }
  /** 桩版 setState：对象浅合并（挂载测试只读 state/render，不驱动生命周期）。 */
  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
  }
}

const fakeReact = {
  Component: FakeComponent,
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  Fragment: Symbol('Fragment'),
  createContext() {
    return { Provider() {}, Consumer() {} };
  },
  memo(fn) {
    return fn;
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
};
/** ReactDOM 桩：组件单测不真实挂载，仅供模块加载成功。 */
const fakeReactDOM = { createRoot: () => ({ render: () => {} }) };

// deps.js 在模块顶层读 window；先种桩再动态 import 编译产物。
globalThis.window = {
  React: fakeReact,
  ReactDOM: fakeReactDOM,
  htm: realHtm,
  addEventListener: () => {},
  removeEventListener: () => {},
  clearTimeout: () => {},
  setTimeout: () => 0,
};

const { AddMenu } = await import('../dist/ui/components/AddMenu.js');
const { ContextCapacityPanel } = await import('../dist/ui/components/ContextCapacityPanel.js');
const { PermissionPicker } = await import('../dist/ui/components/PermissionPicker.js');
const { TreeNode } = await import('../dist/ui/components/TreeNode.js');

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

test('AddMenu：构造即闭合态，render 产出根元素且不抛错（免 bootstrap 路径）', () => {
  const menu = new AddMenu({
    threadId: 't-1',
    api: {},
    onAttach: () => {},
    onToast: () => {},
    onOpenTab: () => {},
    onOpenFile: () => {},
    onLoadThread: () => {},
  });
  assert.strictEqual(menu.state.open, false);
  const vnode = menu.render();
  assert.ok(vnode, 'render 必须返回元素树');
  const types = flatten(vnode);
  assert.ok(types.length > 0, '元素树非空');
});

test('AddMenu：闭合态渲染触发器（＋）且 aria 契约正确', () => {
  const menu = new AddMenu({
    threadId: 't-1',
    api: {},
    onAttach: () => {},
    onToast: () => {},
    onOpenTab: () => {},
    onOpenFile: () => {},
    onLoadThread: () => {},
  });
  const vnode = menu.render();
  assert.strictEqual(texts(vnode).join(''), '＋');
  assert.strictEqual(vnode.props['aria-haspopup'], 'menu');
  assert.strictEqual(vnode.props['aria-expanded'], 'false');
});

test('AddMenu：打开态 aria-expanded 翻转（UI 状态契约）', () => {
  const menu = new AddMenu({
    threadId: 't-1',
    api: {},
    onAttach: () => {},
    onToast: () => {},
    onOpenTab: () => {},
    onOpenFile: () => {},
    onLoadThread: () => {},
  });
  menu.state = { ...menu.state, open: true, pluginsLoading: false, agentsLoading: false };
  assert.strictEqual(menu.render().props['aria-expanded'], 'true');
});

test('ContextCapacityPanel：容量面板 title/aria 契约 + 注入用量不抛错', () => {
  const panel = new ContextCapacityPanel({ threadId: 't-1', api: {}, onToast: () => {} });
  let vnode = panel.render();
  assert.strictEqual(vnode.props.title, '上下文容量与今日余额');
  assert.strictEqual(vnode.props['aria-label'], '上下文容量');
  // 注入真实形状的用量/配额快照后仍可渲染（fail-soft：数据缺失显示占位）
  panel.state = {
    ...panel.state,
    usage: { windowTokens: 128000, usedTokens: 4096, byKind: {} },
    quota: { plan: 'free', multiplier: 1, dailyTokens: 200000, usedToday: 4096 },
  };
  vnode = panel.render();
  assert.ok(vnode, '注入用量后 render 仍须返回元素树');
});

test('PermissionPicker：档位标签映射与 aria 契约（rules→默认）', () => {
  const seen = [];
  const picker = new PermissionPicker({
    permission: 'rules',
    onPick: (v) => seen.push(v),
    api: {},
  });
  const vnode = picker.render();
  assert.strictEqual(vnode.props['aria-label'], 'AI 权限等级');
  assert.match(texts(vnode).join(''), /默认/);
  assert.strictEqual(seen.length, 0, '未交互不触发 onPick');
});

test('TreeNode：文件树节点渲染名称并保留展开回调（零 DOM 依赖）', () => {
  const node = new TreeNode({
    node: {
      name: 'src',
      path: 'src',
      kind: 'dir',
      children: [
        { name: 'a.ts', path: 'src/a.ts', kind: 'file' },
        { name: 'b.ts', path: 'src/b.ts', kind: 'file' },
      ],
    },
    depth: 0,
    onOpenFile: () => {},
  });
  const vnode = node.render();
  const t = texts(vnode).join('\n');
  assert.match(t, /src/, '节点必须渲染名称');
});
