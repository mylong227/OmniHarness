/**
 * 权限编辑器判据（Web 交付项，2026-10-11）。
 *
 * ## 判据要钉死什么（这是一条**写盘**入口，标准比只读面板更高）
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 服务端拒绝时**原样显示原因**（含"哪一条/哪个字段"） | 折叠成"保存失败" ⇒ 用户无从修 |
 * | ② | **不得乐观更新**：拒绝后编辑态保留、不显示"已保存" | 用户以为存上了，实际没存（安全边界失真） |
 * | ③ | 成功后才显示"已保存" | 空口报成功 |
 * | ④ | 合法取值**写在界面上**（decision 三档 + 四个字段名 + deny 优先语义） | 用户撞 400 才知道合法值（F9 配置键出口同源） |
 * | ⑤ | 空串字段**不落盘**（`toWireRules` 省略空串） | 把空串写进配置 ⇒ 服务端判"应为非空字符串"而拒绝可用规则 |
 * | ⑥ | 入口已注册（PANELS + Router） | 漏注册 ⇒ 入口静默落回默认面板 |
 *
 * 迁移（2026-10-18）：旧用例用 hook 槽位摆 rules/saved/error/notice；真实 React 下改成
 * **让组件真的取配置、真的按保存**（`renderFacadeAsync` + `waitFor`），并补上"拒绝后编辑态仍在"
 * 这条原来只靠槽位隐含的行为。断言仍读文案 / disabled / aria 契约。
 */

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { allText, byTag, facadeOf } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';

/** 深度收集满足谓词的外观节点（2026-10-30 W4：按 aria-label 定位 antd 控件内部输入用）。 */
function collect(vnode: Facade, pred: (n: FacadeNode) => boolean): FacadeNode[] {
  const out: FacadeNode[] = [];
  const walk = (n: FacadeNode | null): void => {
    if (n === null) return;
    if (pred(n)) out.push(n);
    for (const c of n.children) if (typeof c !== 'string') walk(c);
  };
  walk(vnode);
  return out;
}

const { PermissionTab, rulesOf, toWireRules } = await import(
  '../src/ui/components/tabs/PermissionTab.tsx'
);
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 渲染权限面板并等首次 `getConfig` 落地。
 * @param responses 按 api 方法名给返回值（`getConfig` / `updateConfig`）
 * @returns 渲染句柄
 */
async function renderSeeded(responses: Record<string, unknown>) {
  const ui = await renderFacadeAsync(PermissionTab, { props: {}, responses });
  /** 从同一容器取当前渲染树（编辑/保存都会重渲染）。 */
  const tree = (): Facade => facadeOf(ui.container.firstElementChild);
  return { ui, tree };
}

/** 取「保存」按钮。 */
function saveButton(tree: Facade): FacadeNode | undefined {
  return byTag(tree, 'button').find((b) => allText(b) === '保存');
}

/** 点「新增规则」（让面板进入 dirty 态）。 */
function addRule(tree: Facade): void {
  const btn = byTag(tree, 'button').find((b) => allText(b) === '新增规则');
  assert.ok(btn !== undefined, '必须有新增规则按钮');
  fireEvent.click(btn.el);
}

test('① 服务端拒绝 ⇒ 原样显示原因（哪一条 / 哪个字段 / 为什么），且不乐观更新', async () => {
  const { tree } = await renderSeeded({
    getConfig: { permission: { rules: [] } },
    updateConfig: () => {
      throw new Error(
        '配置错误: permission.rules[0] 缺 decision（必填：allow | deny | ask）；没有它这条规则不会生效',
      );
    },
  });
  addRule(tree());
  const user = userEvent.setup();
  // 2026-10-30 W4：裁决下拉换 antd Select——其内部也有搜索 <input>，按 aria-label 定位工具名输入框。
  const toolInput = collect(tree(), (n) => n.props['aria-label'] === '工具名')[0]!;
  await user.type(toolInput.el as HTMLElement, 'shell');
  fireEvent.click(saveButton(tree())!.el);

  await waitFor(() => {
    if (!allText(tree()).includes('保存失败')) throw new Error('保存失败尚未渲染');
  });
  const text = allText(tree());
  assert.match(text, /保存失败/u);
  assert.match(text, /rules\[0\]/u, '必须显示到具体规则下标');
  assert.match(text, /缺 decision/u, '必须显示具体字段与原因');
  assert.doesNotMatch(text, /已保存/u, '被拒绝时不得出现"已保存"（纪律②：不做乐观更新）');
  // 纪律②：拒绝后编辑态保留（用户改了一半的内容不得凭空消失）。
  assert.ok(
    collect(tree(), (n) => n.type === 'input' && n.props['aria-label'] === '工具名').some(
      (n) => n.props.value === 'shell',
    ),
    '拒绝后已输入的规则内容必须保留',
  );
  assert.strictEqual(saveButton(tree())!.props.disabled, undefined, '仍有未保存改动，保存按钮应可再点');
});

test('②/③ 成功才显示"已保存"；且只有 dirty 时才允许保存', async () => {
  const savedRules = [{ decision: 'deny', toolName: 'shell', commandPrefix: '', commandGlob: '' }];
  const { tree } = await renderSeeded({
    getConfig: { permission: { rules: savedRules } },
    updateConfig: { ok: true },
  });
  // 载入后与 saved 一致 ⇒ 无改动，保存禁用（避免空写盘）。
  const clean = saveButton(tree());
  assert.ok(clean !== undefined, '必须有保存按钮');
  assert.strictEqual(clean.props.disabled, true, '无改动时保存按钮应禁用（避免空写盘）');

  addRule(tree());
  assert.strictEqual(saveButton(tree())!.props.disabled, undefined, '有改动时必须可保存');

  fireEvent.click(saveButton(tree())!.el);
  await waitFor(() => {
    if (!allText(tree()).includes('已保存')) throw new Error('保存成功提示尚未渲染');
  });
  assert.match(allText(tree()), /已保存/u);
  // 保存把编辑态对齐到服务端态 ⇒ 再次禁用（不是"永远可点"）。
  assert.strictEqual(saveButton(tree())!.props.disabled, true, '保存成功后应回到 clean 态');
});

test('④ 合法取值与聚合语义写在界面上（F9 配置键出口同源）', async () => {
  const { tree } = await renderSeeded({ getConfig: { permission: { rules: [] } } });
  const text = allText(tree());
  assert.match(text, /allow \| deny \| ask/u, '必须列出合法裁决值');
  assert.match(text, /toolName/u);
  assert.match(text, /commandPrefix/u);
  assert.match(text, /commandGlob/u);
  assert.match(text, /decision/u, '必须点明 decision 是必填');
  assert.match(text, /deny 优先/u, '必须说明多条命中时的聚合顺序（否则用户以为"后写覆盖先写"）');
});

test('⑤ rulesOf / toWireRules：读回缺字段补空串；写出时空串字段被省略', () => {
  const parsed = rulesOf({
    permission: { rules: [{ decision: 'deny', toolName: 'shell' }, { commandGlob: '*rm*' }] },
  });
  assert.deepStrictEqual(parsed, [
    { decision: 'deny', toolName: 'shell', commandPrefix: '', commandGlob: '' },
    // 缺 decision ⇒ 占位 'ask'（真正的拦截在服务端；面板不静默替用户决定一个**更宽**的值）。
    { decision: 'ask', toolName: '', commandPrefix: '', commandGlob: '*rm*' },
  ]);
  const wire = toWireRules([
    { decision: 'deny', toolName: 'shell', commandPrefix: '', commandGlob: '' },
    { decision: 'allow', toolName: '', commandPrefix: 'git ', commandGlob: '' },
  ]);
  assert.deepStrictEqual(wire, [
    { decision: 'deny', toolName: 'shell' },
    { decision: 'allow', commandPrefix: 'git ' },
  ]);
  // 正对照：空串若被原样写出，服务端会判"应为非空字符串"而拒绝**本可合法**的规则。
  assert.ok(!JSON.stringify(wire).includes('""'), '空串字段不得出现在待落盘对象里');
});

test('⑥ 入口已注册：PANELS 含 permission，Router 认可该 pane', () => {
  assert.ok(PANELS.some((p) => p.key === 'permission'), 'PANELS 必须含 permission');
  const saved = globalThis.location;
  try {
    // 桩只提供 parseHash 用到的 hash 字段（Location 其余成员在本判据中不被触碰）。
    globalThis.location = { hash: '#pane=permission' } as Location;
    assert.strictEqual(parseHash().pane, 'permission');
  } finally {
    globalThis.location = saved;
  }
});
