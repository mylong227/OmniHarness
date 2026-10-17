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
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();

const { PermissionTab, rulesOf, toWireRules } = await import(
  '../src/ui/components/tabs/PermissionTab.tsx'
);
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 渲染一次组件（函数组件：换组件即清槽位）。
 * @param props 组件属性
 * @param seed hook 槽位预设值
 * @returns vnode 树
 */
function renderSeeded(props, seed) {
  runtime.reset();
  return runtime.render(PermissionTab, props, seed);
}

/**
 * 收集整棵树的文本叶子（无缝拼接）。
 * @param vnode vnode 树
 * @param out 收集器
 * @returns 文本片段
 */
function texts(vnode, out = []) {
  if (Array.isArray(vnode)) {
    for (const node of vnode) texts(node, out);
    return out;
  }
  if (vnode === null || vnode === undefined) return out;
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    out.push(String(vnode));
    return out;
  }
  texts(vnode.children, out);
  return out;
}

/**
 * 深度收集满足谓词的节点。
 * @param vnode vnode 树
 * @param pred 谓词
 * @param out 收集器
 * @returns 命中节点
 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const node of vnode) collect(node, pred, out);
    return out;
  }
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

/**
 * 以给定状态渲染并取文本（hook 序：0=rules 1=saved 2=error 3=notice 4=loading）。
 * @param state 覆盖的槽位值
 * @returns 面板文本
 */
function textWith(state = {}) {
  const base = {
    0: [],
    1: [],
    2: null,
    3: null,
    4: false,
  };
  const tree = renderSeeded({}, { ...base, ...state });
  return texts(tree).join('');
}

test('① 服务端拒绝 ⇒ 原样显示原因（哪一条 / 哪个字段 / 为什么）', () => {
  const text = textWith({
    2: '配置错误: permission.rules[0] 缺 decision（必填：allow | deny | ask）；没有它这条规则不会生效',
  });
  assert.match(text, /保存失败/u);
  assert.match(text, /rules\[0\]/u, '必须显示到具体规则下标');
  assert.match(text, /缺 decision/u, '必须显示具体字段与原因');
  assert.doesNotMatch(text, /已保存/u, '被拒绝时不得出现"已保存"（纪律②：不做乐观更新）');
});

test('②/③ 成功才显示"已保存"；且只有 dirty 时才允许保存', () => {
  const savedRules = [{ decision: 'deny', toolName: 'shell', commandPrefix: '', commandGlob: '' }];
  const clean = renderSeeded({}, { 0: savedRules, 1: savedRules, 2: null, 3: '已保存（服务端已校验并落盘）', 4: false });
  assert.match(texts(clean).join(''), /已保存/u);
  const saveBtn = collect(clean, (n) => n.type === 'button' && texts(n).join('') === '保存')[0];
  assert.ok(saveBtn !== undefined, '必须有保存按钮');
  assert.strictEqual(saveBtn.props.disabled, true, '无改动时保存按钮应禁用（避免空写盘）');

  const dirty = renderSeeded({}, {
    0: [{ decision: 'allow', toolName: '', commandPrefix: '', commandGlob: '' }],
    1: [],
    2: null,
    3: null,
    4: false,
  });
  const dirtyBtn = collect(dirty, (n) => n.type === 'button' && texts(n).join('') === '保存')[0];
  assert.strictEqual(dirtyBtn?.props.disabled, false, '有改动时必须可保存');
});

test('④ 合法取值与聚合语义写在界面上（F9 配置键出口同源）', () => {
  const text = textWith();
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
    globalThis.location = { hash: '#pane=permission' };
    assert.strictEqual(parseHash().pane, 'permission');
  } finally {
    globalThis.location = saved;
  }
});
