// 应用控制器纯归约器测试（D6 护栏 + C3 拆分安全网）。
// 零 DOM 依赖：直接对拍 ./controllers/AppReducers.js 的各个纯方法输出，锁死「状态变换」语义，
// 保证把 App 的 69 个 hook 抽到 AppController + 子控制器后行为不变。
// 覆盖：事件累加、工具结果/增量合并、graph 进度/完成/轮询、会话合并、
// 工具项聚合、finalText 兜底去重、命令面板构造。
//
// 运行方式：web:build 编译出 web/dist 后，node --test web/test/*.test.mjs 直跑。

import assert from 'node:assert/strict';
import test from 'node:test';
import { AppReducers } from '../dist/ui/controllers/AppReducers.js';
import { KeyboardShortcuts } from '../dist/ui/models/KeyboardShortcuts.js';

const r = new AppReducers();

test('appendEvent：向事件流追加一条', () => {
  const prev = [{ id: '1', type: 'assistant', timestamp: 0, payload: {} }];
  const ev = { id: '2', type: 'tool_call', timestamp: 1, payload: {} };
  const next = r.appendEvent(prev, ev);
  assert.strictEqual(next.length, 2);
  assert.strictEqual(next[1], ev);
  assert.notStrictEqual(next, prev, '必须返回新数组（不可变）');
});

test('mergeToolResult：ok/error/output/空 四种文本映射', () => {
  const base = {};
  assert.deepStrictEqual(r.mergeToolResult(base, 'c1', { ok: true }), { c1: { text: '✓ 成功', ok: true } });
  assert.deepStrictEqual(r.mergeToolResult(base, 'c1', { error: 'boom' }), { c1: { text: '✗ boom', ok: false } });
  assert.deepStrictEqual(r.mergeToolResult(base, 'c1', { output: 'hi' }), { c1: { text: 'hi', ok: false } });
  assert.deepStrictEqual(r.mergeToolResult(base, 'c1', {}), { c1: { text: '✗ 失败', ok: false } });
});

test('mergeToolInput：新建 → 同 id 增量覆盖 → 缺 id 原样返回', () => {
  const a = r.mergeToolInput([], { id: 'x', name: 'ls', partialJson: 'abc' });
  assert.deepStrictEqual(a, [{ id: 'x', name: 'ls', partial: 'abc' }]);
  const b = r.mergeToolInput(a, { id: 'x', partialJson: 'def' });
  assert.deepStrictEqual(b, [{ id: 'x', name: 'ls', partial: 'def' }], '同 id 应只更新 partial');
  const c = r.mergeToolInput(a, { partialJson: 'z' });
  assert.strictEqual(c, a, '缺 id 必须原样返回（引用相等）');
});

test('applyGraphProgress：首条建 run，节点按 id 合并覆盖', () => {
  const p1 = { runId: 'r1', id: 'n1', status: 'running' };
  const s1 = r.applyGraphProgress({}, p1);
  assert.strictEqual(s1.r1.nodes.length, 1);
  assert.strictEqual(s1.r1.nodes[0].status, 'running');
  const p2 = { runId: 'r1', id: 'n1', status: 'done', durationMs: 12 };
  const s2 = r.applyGraphProgress(s1, p2);
  assert.strictEqual(s2.r1.nodes.length, 1, '同节点 id 不应新增');
  assert.strictEqual(s2.r1.nodes[0].status, 'done');
  assert.strictEqual(s2.r1.nodes[0].durationMs, 12);
  const p3 = { runId: 'r1', id: 'n2', status: 'running' };
  const s3 = r.applyGraphProgress(s2, p3);
  assert.strictEqual(s3.r1.nodes.length, 2);
});

test('applyGraphProgress：缺 runId 原样返回', () => {
  const prev = { r1: { runId: 'r1', defName: '', done: false, ok: undefined, nodes: [], blackboard: undefined, error: undefined } };
  assert.strictEqual(r.applyGraphProgress(prev, { runId: undefined }), prev);
});

test('applyGraphDone：标记完成并写入 ok/blackboard', () => {
  const prev = { r1: { runId: 'r1', defName: 'g', done: false, ok: undefined, nodes: [], blackboard: undefined, error: undefined } };
  const next = r.applyGraphDone(prev, { runId: 'r1', ok: true, blackboard: { x: 1 } });
  assert.strictEqual(next.r1.done, true);
  assert.strictEqual(next.r1.ok, true);
  assert.deepStrictEqual(next.r1.blackboard, { x: 1 });
  // 不存在的 runId 不写入
  assert.strictEqual(r.applyGraphDone(prev, { runId: 'nope', ok: false }), prev);
});

test('buildGraphRunInitial：初始态形状正确', () => {
  assert.deepStrictEqual(r.buildGraphRunInitial('r1', 'name'), {
    runId: 'r1',
    defName: 'name',
    done: false,
    ok: undefined,
    nodes: [],
    blackboard: undefined,
    error: undefined,
  });
});

test('applyGraphStatus：轮询快照合并进 run（含节点合并）', () => {
  const st = { runId: 'r1', defName: 'g', done: true, ok: true, nodes: [{ id: 'n1', status: 'done' }], blackboard: { k: 2 }, error: undefined };
  const next = r.applyGraphStatus({}, 'r1', st);
  assert.strictEqual(next.r1.done, true);
  assert.strictEqual(next.r1.defName, 'g');
  assert.strictEqual(next.r1.nodes.length, 1);
});

test('mergeSessions：磁盘列表覆盖同 id；消失的 id 移除（已归档例外）', () => {
  // 2026-10-07 推翻旧契约「保留在册未落盘的会话」：服务端 sessions.list 按工作区过滤，
  // 切项目后旧会话正好不在响应里——旧契约把它们永久留在内存 ⇒ 用户报「切工作区还显示之前的会话」。
  // 现契约：消失即移除；唯一例外是已归档（快速刷新不扫归档目录，靠本规则保住「已归档」组）。
  const prev = [
    { id: 'mem-only', label: '内存会话', archived: false },
    { id: 'arch', label: '归档会话', archived: true },
    { id: 'a', label: '旧a' },
  ];
  const disk = [{ id: 'a', label: '新a' }, { id: 'b', label: 'b' }];
  const next = r.mergeSessions(prev, disk);
  assert.deepStrictEqual(
    next.map((s) => s.id),
    ['arch', 'a', 'b'],
    '未落盘且未归档的会话必须移除（切工作区不再残留）；已归档保留；磁盘同 id 覆盖',
  );
  assert.strictEqual(next[0].archived, true, '保留的归档行不得丢失归档标记');
});

test('buildToolItems：tool_call 聚合状态，非 tool_call 跳过', () => {
  const events = [
    { id: '1', type: 'assistant', timestamp: 0, payload: {} },
    { id: '2', type: 'tool_call', timestamp: 0, payload: { callId: 'c1', name: 'ls' } },
    { id: '3', type: 'tool_call', timestamp: 0, payload: { callId: 'c2', name: 'grep' } },
  ];
  const results = { c1: { text: '', ok: true } };
  const items = r.buildToolItems(events, results);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].status, 'ok', '有结果 → ok');
  assert.strictEqual(items[1].status, 'pending', '无结果 → pending');
  assert.strictEqual(items[0].callId, 'c1');
});

test('appendFinalText：去重 + 空/空白跳过（send 兜底分支）', () => {
  const prev = [{ id: 'a', type: 'assistant', timestamp: 0, payload: { content: '已有总结' } }];
  const added = r.appendFinalText(prev, '新的总结');
  assert.strictEqual(added.length, 2);
  assert.strictEqual(added[1].type, 'assistant');
  assert.strictEqual(added[1].payload.content, '新的总结');
  // 与已有 assistant 内容重复 → 不追加
  assert.strictEqual(r.appendFinalText(prev, '已有总结'), prev);
  // 空 / 纯空白 → 原样返回（引用相等）
  assert.strictEqual(r.appendFinalText(prev, undefined), prev);
  assert.strictEqual(r.appendFinalText(prev, '   '), prev);
});

// 2026-10-07 用户实测：「原本会话下继续发一条话后，滚轮从下向上滚，渲染内容就会重复变越来越多」。
// 事件流是**至少一次**投递（SSE 重连补发 / resume 回放 / 双订阅都会重投同一条 id），
// 归约器此前无条件追加 ⇒ 重复事件越堆越多（虚拟化滚动才逐段显形，所以症状是"往上滚越来越多"）。
test('appendEvent：同一 id 重投必须被忽略（否则重复事件越堆越多）', () => {
  const ev = { id: 'evt_1', type: 'tool_call', timestamp: 1, payload: {} };
  const prev = [ev];
  assert.strictEqual(r.appendEvent(prev, { ...ev }), prev, '同 id 重投 ⇒ 原样返回（引用不变）');
  const fresh = { id: 'evt_2', type: 'assistant', timestamp: 2, payload: {} };
  assert.strictEqual(r.appendEvent(prev, fresh).length, 2, '新 id 照常追加');
  // id 缺失无法判定 ⇒ 仍按新事件追加（不静默丢事件）
  assert.strictEqual(r.appendEvent(prev, { type: 'assistant', timestamp: 3, payload: {} }).length, 2);
});

test('ingestEvent：同 id 重投不得清空流式缓冲 / 覆盖收口标记', () => {
  const ev = { id: 'evt_a', type: 'assistant', timestamp: 1, payload: { content: 'x' } };
  const prev = { events: [ev], streamText: '正在生成', finalizedStreamText: '上一段' };
  const next = r.ingestEvent(prev, { ...ev });
  assert.strictEqual(next.events, prev.events, 'events 引用不变（不重渲染）');
  assert.strictEqual(next.streamText, '正在生成', '重投不得把流式文本清空');
  assert.strictEqual(next.finalizedStreamText, '上一段', '重投不得覆盖收口标记');
  const appended = r.ingestEvent(prev, { id: 'evt_b', type: 'assistant', timestamp: 2, payload: {} });
  assert.strictEqual(appended.events.length, 2, '新 id 照常并入并收口流式文本');
  assert.strictEqual(appended.streamText, '');
  assert.strictEqual(appended.finalizedStreamText, '正在生成');
});

test('appendFinalText：只与最后一条 assistant 比（更早同文不得吞掉本条，末条差空白不得重复）', () => {
  const prev = [
    { id: 'a1', type: 'assistant', timestamp: 0, payload: { content: '同文' } },
    { id: 'a2', type: 'assistant', timestamp: 1, payload: { content: '另一段' } },
  ];
  assert.strictEqual(
    r.appendFinalText(prev, '同文').length,
    3,
    '更早的 assistant 同文 ⇒ 仍必须追加（旧实现会吞掉本条 = 内容丢失）',
  );
  const tailSame = [{ id: 'a', type: 'assistant', timestamp: 0, payload: { content: '总结\n' } }];
  assert.strictEqual(
    r.appendFinalText(tailSame, '总结'),
    tailSame,
    '末条只差首尾空白 ⇒ 视为同一条，不再重复落一条',
  );
});

test('appendTextDelta：增量拼接，不覆盖既有内容', () => {
  assert.strictEqual(r.appendTextDelta('', '你'), '你');
  assert.strictEqual(r.appendTextDelta('你', '好'), '你好');
  assert.strictEqual(r.appendTextDelta('你好', ''), '你好', '空增量不得改变现状');
});

test('ingestEvent：assistant 事件收口流式文本，其余事件不动流式态', () => {
  const base = { events: [], streamText: '你好，世界', finalizedStreamText: '' };
  // 非 assistant：流式文本原样保留，事件追加
  const afterTool = r.ingestEvent(base, { id: 't1', type: 'tool_call', timestamp: 1, payload: {} });
  assert.strictEqual(afterTool.streamText, '你好，世界');
  assert.strictEqual(afterTool.finalizedStreamText, '');
  assert.strictEqual(afterTool.events.length, 1);
  // assistant：流式文本清空并转存到 finalized（供 StreamView 抑制重复揭示动画）
  const afterAssistant = r.ingestEvent(base, {
    id: 'a1',
    type: 'assistant',
    timestamp: 2,
    payload: { content: '你好，世界' },
  });
  assert.strictEqual(afterAssistant.streamText, '', 'assistant 落账后必须清空流式缓冲');
  assert.strictEqual(afterAssistant.finalizedStreamText, '你好，世界');
  assert.strictEqual(afterAssistant.events.length, 1);
});

test('ingestEvent：无流式缓冲时 assistant 不收口（避免污染 finalized）', () => {
  const base = { events: [], streamText: '', finalizedStreamText: 'old' };
  const next = r.ingestEvent(base, { id: 'a2', type: 'assistant', timestamp: 3, payload: { content: 'x' } });
  assert.strictEqual(next.streamText, '');
  assert.strictEqual(next.finalizedStreamText, 'old', '空缓冲时不得把 finalized 清成空串');
});

test('buildCommands：16 条命令，run 闭包正确驱动依赖', () => {
  const calls = { pane: null, right: false, newSession: 0, reload: 0, theme: 0, left: 0, right: 0 };
  const cmds = r.buildCommands({
    setActivePane: (k) => (calls.pane = k),
    setRightOpen: () => (calls.right = true),
    newSession: () => (calls.newSession += 1),
    refreshSessions: () => (calls.reload += 1),
    toggleTheme: () => (calls.theme += 1),
    toggleLeft: () => (calls.left += 1),
    toggleRight: () => (calls.right += 1),
  });
  assert.strictEqual(cmds.length, 16, '11 面板 + 5 动作');
  const paneTools = cmds.find((c) => c.id === 'pane-tools');
  paneTools.run();
  assert.strictEqual(calls.pane, 'tools');
  assert.strictEqual(calls.right, true);
  cmds.find((c) => c.id === 'new-session').run();
  cmds.find((c) => c.id === 'reload-sessions').run();
  cmds.find((c) => c.id === 'toggle-theme').run();
  assert.strictEqual(calls.newSession, 1);
  assert.strictEqual(calls.reload, 1);
  assert.strictEqual(calls.theme, 1);
});
