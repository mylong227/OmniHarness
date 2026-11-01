// @vitest-environment jsdom
// 思考轨迹（2026-11-01）组件判据：
//   · 收尾后折叠成一行「总思考」，点开按顺序列出每条思考与工具调用；
//   · 完成的思考有勾选标记，点击单条可展开全文；
//   · 运行中自动展开、标题是「思考中」，且只有**最后一条**思考处于运行态。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderUi } from './rtlHarness.ts';
import { ThinkingTrail } from '../src/ui/components/stream/ThinkingTrail.tsx';
import type { ThreadEvent } from '../src/types/models.ts';

/** 造一条带时间戳的事件。 */
function ev(id: string, type: string, timestamp: number, payload: Record<string, unknown>): ThreadEvent {
  return { id, type, timestamp, payload } as ThreadEvent;
}

/** 本轮事件：思考 → 工具调用 → 工具回执 → 思考。 */
const EVENTS: ThreadEvent[] = [
  ev('r1', 'reasoning', 1_000, { content: '先读现有实现。' }),
  ev('c1', 'tool_call', 2_000, { callId: 'k1', name: 'read_file', args: { path: 'a.ts' } }),
  ev('x1', 'tool_result', 3_000, { callId: 'k1', ok: true, output: 'ok' }),
  ev('r2', 'reasoning', 5_000, { content: '再改结果卡。' }),
];

/** 渲染回调：工具调用出一行，回执（已被调用卡内联）返回 null。 */
function renderEvent(e: ThreadEvent): ReactElement | null {
  if (e.type === 'tool_result') return null;
  return <div className="fake-tool">工具行</div>;
}

test('收尾后折叠成一行「总思考」，点开后按顺序列出思考与工具行', () => {
  const ui = renderUi(ThinkingTrail, { props: { events: EVENTS, busy: false, renderEvent } });
  const head = ui.container.querySelector('.tt-head');
  assert.ok(head !== null);
  assert.strictEqual(head.getAttribute('aria-expanded'), 'false', '收尾后默认折叠');
  assert.strictEqual(ui.container.querySelector('.tt-title')?.textContent, '总思考');
  assert.strictEqual(ui.container.querySelectorAll('.tt-step').length, 0, '折叠时不渲染步骤');
  assert.ok((head.textContent ?? '').includes('3 步'), '折叠行给出步数（2 条思考 + 1 次工具调用）');

  fireEvent.click(head);
  const rows = ui.container.querySelectorAll('.tt-step');
  assert.strictEqual(rows.length, 2, '两步思考各一行');
  assert.strictEqual(ui.container.querySelectorAll('.tt-event .fake-tool').length, 1, '工具调用同处一条时间线');
  assert.strictEqual(ui.container.querySelectorAll('.tt-step svg').length, 2, '完成的思考有勾选标记');
  assert.ok((ui.container.querySelector('.tt-body')?.textContent ?? '').includes('先读现有实现。'));
});

test('单条思考点开展开全文，再点收起', () => {
  const ui = renderUi(ThinkingTrail, { props: { events: EVENTS, busy: false, renderEvent } });
  fireEvent.click(ui.container.querySelector('.tt-head')!);
  const stepHead = ui.container.querySelector('.tt-step-head');
  assert.ok(stepHead !== null);
  assert.strictEqual(stepHead.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(ui.container.querySelectorAll('.tt-think').length, 0);

  fireEvent.click(stepHead);
  const body = ui.container.querySelector('.tt-think');
  assert.ok(body !== null);
  assert.strictEqual(body.textContent, '先读现有实现。');
  assert.strictEqual(ui.container.querySelector('.tt-step-head')?.getAttribute('aria-expanded'), 'true');

  fireEvent.click(ui.container.querySelector('.tt-step-head')!);
  assert.strictEqual(ui.container.querySelectorAll('.tt-think').length, 0, '再点收起全文');
});

test('过程旁白（中间的助手消息）在轨迹里显示为「说明」步骤', () => {
  const withNote = [
    ...EVENTS.slice(0, 2),
    ev('a1', 'assistant', 2_500, { content: '让我先读一下现有实现。' }),
    ...EVENTS.slice(2),
  ];
  const ui = renderUi(ThinkingTrail, { props: { events: withNote, busy: false, renderEvent } });
  const head = ui.container.querySelector('.tt-head');
  assert.ok((head?.textContent ?? '').includes('说明 1 次'), '折叠行摘要要包含旁白次数');
  fireEvent.click(head!);
  const labels = Array.from(ui.container.querySelectorAll('.tt-step-label')).map(
    (node) => node.textContent,
  );
  assert.deepStrictEqual(labels, ['思考', '说明', '思考'], '旁白按发生顺序插在思考之间');
  const notes = ui.container.querySelectorAll('.tt-step');
  assert.strictEqual(notes.length, 3, '两条思考 + 一条说明');
});

test('运行中：自动展开、标题「思考中」，只有最后一条思考在运行', () => {
  const ui = renderUi(ThinkingTrail, { props: { events: EVENTS, busy: true, renderEvent } });
  assert.strictEqual(ui.container.querySelector('.tt-title')?.textContent, '思考中');
  assert.strictEqual(ui.container.querySelector('.tt-head')?.getAttribute('aria-expanded'), 'true');
  const running = ui.container.querySelectorAll('.tt-step.running');
  assert.strictEqual(running.length, 1, '只有正在生成的那条思考带运行态');
  assert.ok(running[0]?.querySelector('.tt-spinner') !== null, '运行态有转圈动画');
  assert.ok((ui.container.querySelector('.tt-body')?.textContent ?? '').includes('再改结果卡。'));
});

test('没有过程事件时不渲染轨迹', () => {
  const ui = renderUi(ThinkingTrail, { props: { events: [], busy: false, renderEvent } });
  assert.strictEqual(ui.root, null);
});
