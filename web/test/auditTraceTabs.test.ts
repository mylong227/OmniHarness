/**
 * 审计面板 + Trace 自省面板判据（Web 交付项，2026-10-11）。
 *
 * ## 判据要钉死什么（两条都围绕"没有 ≠ 正常"）
 *
 * `audit.query` 与 `trace.read` 的返回体都能表达"**读取失败/未接线**"，面板必须把它与
 * "**查到了但没有记录**"分开渲染：
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 审计：`ok:false` ⇒ 显示"未接线"+原因，**不得**出现"无匹配事件" | 没装 audit sink 被读成"审计无记录"（本仓反复记录的形态） |
 * | ② | 审计：`ok:true` + 空 events ⇒ 明确写"无匹配事件（sink 已接线）" | 与①混为一谈 |
 * | ③ | 审计：每条显示链序号 `#seq`（未入链显式写"未入链"） | 排查篡改时第一个要看的字段消失 |
 * | ④ | Trace：无会话 ⇒ 提示先选会话（不猜"最近会话"糊一个结果） | 面板显示别的会话的 trace 而用户以为是自己那个 |
 * | ⑤ | Trace：`error` 非空 ⇒ 直说原因，**不得**渲染空列表 | "会话不存在"被读成"该会话没有事件" |
 * | ⑥ | Trace：`error` 为空且 0 条 ⇒ 写"本次查询无匹配条目"；正例显示 seq/kind/summary | 与⑤混为一谈 |
 * | ⑦ | 入口已注册：`PANELS` 含 audit/trace，`Router` 认可两个 pane | 漏注册 ⇒ 入口静默落回默认面板 |
 */

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderFacadeAsync } from './rtlHarness.ts';
import { allText as facadeAllText } from './domFacade.ts';


const { AuditTab } = await import('../src/ui/components/tabs/AuditTab.tsx');
const { TraceTab } = await import('../src/ui/components/tabs/TraceTab.tsx');
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 渲染一次组件（函数组件：换组件即清槽位）。
 * @param Component 组件函数（签名沿用桩 render 的组件形参口径）
 * @param props 组件属性
 * @param seed hook 槽位预设值
 * @returns vnode 树
 */
/**
 * 渲染组件并等一次取数落地，返回外观节点。
 *
 * 迁移说明（2026-10-18）：旧写法用 `seed` 直接摆"已取到的数据"。真实 React 下改成
 * 让组件真的去取——把种子里的取数结果交给对应 api 方法，顺带覆盖真实取数路径。
 *
 * @param Component 组件
 * @param props 组件属性
 * @param responses 按 api 方法名给返回值
 * @returns 外观节点
 */
async function renderSeeded(
  Component: Parameters<typeof renderFacadeAsync>[0],
  props: Record<string, unknown>,
  responses: Record<string, unknown>,
) {
  const ui = await renderFacadeAsync(Component, { props, responses });
  return ui.node;
}

/**
 * 渲染审计面板并取文本。
 * @param data audit.query 返回体
 * @returns 面板文本
 */
async function auditText(data: unknown) {
  const ui = await renderSeeded(AuditTab, {}, { auditQuery: data });
  return facadeAllText(ui);
}

/**
 * 渲染 trace 面板并取文本。
 * @param data trace.read 返回体
 * @param sessionId 会话 id
 * @returns 面板文本
 */
async function traceText(data: unknown, sessionId = 'sess-1') {
  const ui = await renderSeeded(TraceTab, { sessionId }, { traceRead: data });
  return facadeAllText(ui);
}

test('① 审计：ok:false（未接线）⇒ 显示"未接线"+原因，且**不得**出现"无匹配事件"', async () => {
  const text = await auditText({ ok: false, reason: 'audit 未接线（serve 组合根未注入 audit sink）' });
  assert.match(text, /未接线/u, '必须显示"未接线"');
  assert.match(text, /未注入 audit sink/u, '必须带出服务端给的原因');
  assert.doesNotMatch(text, /无匹配事件/u, '未接线时不得出现"无匹配事件"（那是把没有读成正常）');
});

test('② 审计：ok:true + 空事件 ⇒ 明确写"无匹配事件"，与①可区分（正对照）', async () => {
  const text = await auditText({ ok: true, events: [] });
  assert.match(text, /无匹配事件/u, '真的没有匹配时必须如实说没有匹配');
  assert.doesNotMatch(text, /未接线/u, '已接线时不得说"未接线"');
});

test('③ 审计：每条显示链序号 #seq；未入链显式写"未入链"', async () => {
  const text = await auditText({
    ok: true,
    events: [
      { ts: '2026-10-11T00:00:00.000Z', type: 'tool_call', sessionId: 's1', seq: 7, hash: 'h' },
      { ts: '2026-10-11T00:00:01.000Z', type: 'approval', sessionId: 's1' },
    ],
  });
  assert.match(text, /#7/u, '入链事件必须显示链序号');
  assert.match(text, /tool_call/u);
  assert.match(text, /approval/u);
  assert.match(text, /未入链/u, '没有 seq 的事件必须显式标注"未入链"（不能静默留空）');
  assert.match(text, /事件（2）/u, '应给出条数');
});

test('④ Trace：无会话 ⇒ 提示先选会话（不猜最近会话）', async () => {
  const text = await traceText(null, '');
  assert.match(text, /请先选择一个会话/u, '空会话必须给出明确指引');
  assert.doesNotMatch(text, /载入/u, '无会话时不该进入载入态');
});

test('⑤ Trace：error 非空 ⇒ 直说原因，**不得**渲染空列表', async () => {
  const text = await traceText({ session: 'sess-1', entries: [], count: 0, error: '会话不存在' });
  assert.match(text, /会话不存在/u, '必须原样显示服务端给的原因');
  assert.doesNotMatch(text, /无匹配条目/u, '会话不存在时不得说"无匹配条目"');
});

test('⑥ Trace：无 error 且 0 条 ⇒ 写"无匹配条目"；正例显示 seq/kind/summary', async () => {
  const empty = await traceText({ session: 'sess-1', entries: [], count: 0 });
  assert.match(empty, /无匹配条目/u, '会话存在但查询无匹配时必须如实说');
  assert.doesNotMatch(empty, /会话不存在/u, '正对照：不得凭空空报"会话不存在"');

  const filled = await traceText({
    session: 'sess-1',
    count: 2,
    entries: [
      { seq: 3, at: '2026-10-11T00:00:00.000Z', kind: 'tool.call', summary: 'shell ls' },
      { seq: 4, at: '2026-10-11T00:00:01.000Z', kind: 'turn.end', summary: '收尾' },
    ],
  });
  assert.match(filled, /#3/u);
  assert.match(filled, /tool\.call/u);
  assert.match(filled, /shell ls/u, 'summary 必须显示（面板的价值就在这一行）');
  assert.match(filled, /本次返回 2 条/u, '必须回显条数，避免"只看 2 条"被读成"总共 2 条"');
});

test('⑦ 入口已注册：PANELS 含 audit/trace，Router 认可两个 pane', async () => {
  for (const key of ['audit', 'trace']) {
    assert.ok(PANELS.some((p) => p.key === key), `PANELS 必须含 ${key}`);
  }
  const saved = globalThis.location;
  try {
    // 桩只提供 parseHash 用到的 hash 字段（Location 其余成员在本判据中不被触碰）。
    globalThis.location = { hash: '#pane=audit' } as Location;
    assert.strictEqual(parseHash().pane, 'audit');
    globalThis.location = { hash: '#pane=trace' } as Location;
    assert.strictEqual(parseHash().pane, 'trace');
  } finally {
    globalThis.location = saved;
  }
});
