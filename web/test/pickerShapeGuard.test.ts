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
// 判据在**真实 React + jsdom** 上做（2026-10-18 迁移）：组件挂载后真的调 `api.browseFs`，
// 非法回包驱动出错误文案；渲染期若仍读 `undefined.length` 会直接让本文件变红。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderFacadeAsync } from './rtlHarness.ts';
import { allText, byTag, facadeOf } from './domFacade.ts';

const { FolderPicker } = await import('../src/ui/components/FolderPicker.tsx');
const { FilePicker } = await import('../src/ui/components/FilePicker.tsx');

/**
 * 造一个只实现 browseFs 的 api 桩。
 *
 * 迁移说明（2026-10-18）：旧用例直接把 `api` 当 prop 传（选择器不走 AppContext），
 * 但用 hook 槽位预设"已加载完成"。真实 React 下让组件**真的去取**：`browseFs` 返回
 * 同一份回包，挂载 effect 走真实加载路径——形状校验因此是**被实际执行**的，而不是被绕过的。
 *
 * @param browseResult fs.browse 的返回体
 * @returns api 桩
 */
function apiWith(browseResult: unknown) {
  return {
    calls: [] as { path: string | undefined; includeFiles: boolean | undefined }[],
    async browseFs(path?: string, includeFiles?: boolean) {
      this.calls.push({ path, includeFiles });
      return browseResult;
    },
    async mkdirFs() {
      return { path: '/tmp/new' };
    },
  };
}

/**
 * 渲染一次并等挂载 effect 里的 `fs.browse` 落地。
 * @param Component 组件
 * @param props 属性
 * @param api api 桩
 * @returns 外观节点
 */
async function renderAfterLoad(
  Component: Parameters<typeof renderFacadeAsync>[0],
  props: Record<string, unknown>,
  api: unknown,
) {
  const ui = await renderFacadeAsync(Component, { props: { ...props, api } });
  // 2026-10-29：选择器浮层换 antd Modal（portal 到 body）⇒ 断言面从 render 容器改为 body。
  void ui;
  return facadeOf(document.body);
}

test('FolderPicker：fs.browse 回 {} 时不得抛错，而是显示格式异常（不卸整页）', async () => {
  const tree = await renderAfterLoad(
    FolderPicker,
    { onCancel: () => {}, onPick: () => {}, workspace: 'D:\\w' },
    apiWith({}),
  );
  assert.match(allText(tree), /返回格式异常/, '必须在选择器内如实提示，而不是让整页渲染出错');
});

test('FolderPicker：drives 层缺 roots/home 时按空处理（不得把 undefined 灌进 state）', async () => {
  const tree = await renderAfterLoad(
    FolderPicker,
    { onCancel: () => {}, onPick: () => {}, workspace: 'D:\\w' },
    apiWith({ level: 'drives' }),
  );
  // 关键断言：渲染不抛错（有任何 .length 读到 undefined 这里就会炸），且不得误报格式异常。
  assert.ok(tree !== null, '形状缺字段也必须能渲染');
  assert.doesNotMatch(allText(tree), /返回格式异常/, '缺 roots/home 属于可缺省字段，应按空处理');
});

test('FilePicker：dir 层缺 dirs 时不得把 undefined 灌进 state（渲染不抛错）', async () => {
  const tree = await renderAfterLoad(
    FilePicker,
    { onCancel: () => {}, onConfirm: () => {}, workspace: 'D:\\w' },
    apiWith({ level: 'dir', path: 'D:\\w' }),
  );
  assert.match(allText(tree), /返回格式异常/, 'FilePicker 也必须 fail-closed 到错误文案');
});

test('对照：合法回包（drives）正常渲染盘符与用户目录，不报格式错误', async () => {
  const tree = await renderAfterLoad(
    FolderPicker,
    { onCancel: () => {}, onPick: () => {}, workspace: 'D:\\w' },
    apiWith({ level: 'drives', roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\me' }),
  );
  const text = allText(tree);
  assert.match(text, /用户目录/, '合法回包必须正常渲染（防止"一律报错"的假修）');
  assert.doesNotMatch(text, /返回格式异常/);
  assert.ok(byTag(tree, 'div').length > 3, '应渲染出条目列表');
});
