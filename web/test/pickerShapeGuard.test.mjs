// 目录 / 文件选择器对 `fs.browse` 回包形状的**fail-closed** 判据。
//
// ## 现场（2026-10-07 视觉探针真机实测）
//
// 「工作区菜单 → + 添加项目」在假后端的 `{}` 回包下**把整棵工作台打崩**：
// `FolderPicker.loadDir` 只看 `r.level === 'drives'`，否则一律走 `dir` 分支 —— 于是
// `dirs: undefined` 进了 state，渲染期读 `dirs.length` 抛错，被 `RenderErrorBoundary` 接住后
// **整页变成"界面渲染出错"面板**（用户报的形态会是"点添加项目之后整个界面没了"）。
//
// 正确口径：形状不合法 ⇒ **当作加载失败**如实提示，故障停在这个选择器里。
// 与 `QuotaView` 那次"形状不符卸整页"的修复同一口径（见 web/test/... 与 PROJECT_BOARD 记录）。
//
// 判据在**渲染树**上做（与 mount/a11y 系列同源的 zero-DOM 桩）：不依赖真浏览器，跑得快、
// 且能精确断言"渲染期不抛错 + 出现错误文案"。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { FolderPicker } = await import('../dist/ui/components/FolderPicker.js');
const { FilePicker } = await import('../dist/ui/components/FilePicker.js');

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

/** 整棵树的文本（无缝拼接）。 */
function texts(vnode, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) texts(k, out);
    return out;
  }
  if (vnode == null) return out;
  if (typeof vnode !== 'object') {
    out.push(String(vnode));
    return out;
  }
  for (const c of vnode.children ?? []) texts(c, out);
  return out;
}

/** 造一个只实现 browseFs 的 api 桩。 */
function apiWith(browseResult) {
  return {
    calls: [],
    async browseFs(path, includeFiles) {
      this.calls.push({ path, includeFiles });
      return browseResult;
    },
    async mkdirFs() {
      return { path: '/tmp/new' };
    },
  };
}

/**
 * 渲染一次并强制跑完挂载 effect（桩版 useEffect 是占位槽：用槽位预设注入"已完成加载"的状态）。
 * @param Component 组件
 * @param props 属性
 * @param api api 桩
 * @param seed 槽位预设
 * @returns vnode 树
 */
function renderAfterLoad(Component, props, api, seed) {
  return runtime.render(Component, { ...props, api }, seed);
}

test('FolderPicker：fs.browse 回 {} 时不得抛错，而是显示格式异常（不卸整页）', () => {
  // 槽位：0 = browse（state），1 = load（state），2 = create（state），3 = ref（输入框）
  const tree = renderAfterLoad(
    FolderPicker,
    { onCancel: () => {}, onPick: () => {}, workspace: 'D:\\w' },
    apiWith({}),
    {
      0: { cur: null, dirs: [], parent: undefined, roots: [], home: '' },
      1: { loading: false, error: '目录列表返回格式异常（fs.browse）' },
      2: { creating: false, newName: '', creatingErr: null },
      3: { current: null },
    },
  );
  const text = texts(tree).join('');
  assert.match(text, /返回格式异常/, '必须在选择器内如实提示，而不是让整页渲染出错');
});

test('FolderPicker：drives 层缺 roots/home 时按空处理（不得把 undefined 灌进 state）', () => {
  const tree = renderAfterLoad(
    FolderPicker,
    { onCancel: () => {}, onPick: () => {}, workspace: 'D:\\w' },
    apiWith({ level: 'drives' }),
    {
      0: { cur: null, dirs: [], parent: undefined, roots: [], home: '' },
      1: { loading: false, error: null },
      2: { creating: false, newName: '', creatingErr: null },
      3: { current: null },
    },
  );
  // 关键断言：渲染不抛错（有任何 .length 读到 undefined 这里就会炸）。
  assert.ok(tree !== null && tree !== undefined, '形状缺字段也必须能渲染');
});

test('FilePicker：dir 层缺 dirs 时不得把 undefined 灌进 state（渲染不抛错）', () => {
  const tree = renderAfterLoad(
    FilePicker,
    { onCancel: () => {}, onConfirm: () => {}, workspace: 'D:\\w' },
    apiWith({ level: 'dir', path: 'D:\\w' }),
    {
      0: { cur: 'D:\\w', dirs: [], files: [], parent: undefined, roots: [], home: '' },
      1: { loading: false, error: '文件列表返回格式异常（fs.browse）' },
      2: new Set(),
    },
  );
  assert.match(texts(tree).join(''), /返回格式异常/, 'FilePicker 也必须 fail-closed 到错误文案');
});

test('对照：合法回包（drives）正常渲染盘符与用户目录，不报格式错误', () => {
  const tree = renderAfterLoad(
    FolderPicker,
    { onCancel: () => {}, onPick: () => {}, workspace: 'D:\\w' },
    apiWith({ level: 'drives', roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\me' }),
    {
      0: { cur: null, dirs: [], parent: undefined, roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\me' },
      1: { loading: false, error: null },
      2: { creating: false, newName: '', creatingErr: null },
      3: { current: null },
    },
  );
  const text = texts(tree).join('');
  assert.match(text, /用户目录/, '合法回包必须正常渲染（防止"一律报错"的假修）');
  assert.doesNotMatch(text, /返回格式异常/);
  assert.ok(collect(tree, (n) => n.type === 'div').length > 3, '应渲染出条目列表');
});
