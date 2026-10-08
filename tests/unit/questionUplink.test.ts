/**
 * 提问上行（`question.request` → `question.respond`）的回归（2026-10-08 用户报障）。
 *
 * 被修的缺陷：Web 端的提问卡是**只读**的（选项按钮恒 disabled），服务端也没有任何「把作答送回
 * 等待中的 `ask_user`」的通道 —— 提问一旦发生，页面上的用户看得见问题却无从提交，回合只能靠
 * 终端（`ConsoleUserResponder`）或超时收场。本测试钉住四件事：
 * ① 端到端闭环：`AskUserTool` → 上行通知 → `question.respond` → 作答进工具结果；
 * ② 超时兜底：到点按「未拿到回答」fail-soft 继续（绝不永久挂起）；
 * ③ 答案校验：题 id / 选项标签 / 单选多选 / 长度任一不合法即拒绝，且**挂起保留**可重提；
 * ④ 断连收尾：`denyAllPending` 一并把挂起提问按 fail-soft 收掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskUserTool } from '../../src/adapters/tool/plan/askUserTool.js';
import { eventFactory } from '../../src/core/eventFactory.js';
import { ServerEventBridge } from '../../src/server/core/serverEventBridge.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import type { RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { AskAnswer, AskQuestion } from '../../src/ports/runtime/userResponder.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 只记录下行消息的假传输。 */
class RecordingTransport implements Transport {
  /** 已下发的消息（通知 / 响应）。 */
  public readonly sent: RpcMessage[] = [];

  /**
   * 记录一条下行消息。
   * @param message RPC 消息
   * @returns 无返回值
   */
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }

  /**
   * 入站订阅（本测试不需要）。
   * @returns 无返回值
   */
  public onMessage(): void {
    // 测试不需要入站
  }

  /**
   * 取最后一条指定方法的通知参数。
   * @param method 通知方法名
   * @returns 参数对象；未命中返回 undefined
   */
  public lastParams(method: string): Record<string, unknown> | undefined {
    const hits = this.sent.filter((message) => (message as { method?: string }).method === method);
    const last = hits.at(-1) as { params?: Record<string, unknown> } | undefined;
    return last?.params;
  }
}

/** 一次提问样本（单选 + 多选各一题）。 */
const QUESTIONS: readonly AskQuestion[] = [
  {
    id: 'q1',
    header: '确认范围',
    question: '这次做哪一种？',
    options: [{ label: 'A' }, { label: 'B' }],
  },
  {
    id: 'q2',
    question: '还想要什么？',
    multiSelect: true,
    options: [{ label: 'X' }, { label: 'Y' }],
  },
];

/**
 * 同一批提问的**模型面**（工具参数）形态：`ask_user` 的参数 schema 用 `multi_select` 拼写，
 * 由工具自身归一为端口里的 `multiSelect`——测试必须走这条真实路径，否则「多选」永远测不到。
 */
const TOOL_ARGS: Record<string, unknown> = {
  questions: [
    {
      id: 'q1',
      header: '确认范围',
      question: '这次做哪一种？',
      options: [{ label: 'A' }, { label: 'B' }],
    },
    {
      id: 'q2',
      question: '还想要什么？',
      multi_select: true,
      options: [{ label: 'X' }, { label: 'Y' }],
    },
  ],
};

/**
 * 建桥并取一次提问的上行参数。
 * @param timeoutMs 提问超时（毫秒）
 * @returns 桥、假传输与「发起提问 → requestId」的便捷函数
 */
function build(timeoutMs: number): {
  bridge: ServerEventBridge;
  transport: RecordingTransport;
  ask: (questions?: readonly AskQuestion[]) => Promise<readonly AskAnswer[]>;
  requestIdOf: () => string;
} {
  const transport = new RecordingTransport();
  const bridge = new ServerEventBridge({ transport, questionTimeoutMs: timeoutMs });
  return {
    bridge,
    transport,
    ask: (questions = QUESTIONS) => bridge.questionPort().ask(questions, { sessionId: 's1' }),
    requestIdOf: () => String(transport.lastParams('question.request')?.['requestId'] ?? ''),
  };
}

test('① 端到端：AskUserTool 的回答经 question.request / question.respond 送达', async () => {
  const { bridge, transport, requestIdOf } = build(60_000);
  const tool = new AskUserTool(bridge.questionPort(), undefined, eventFactory);
  const call: ToolCall = {
    id: 'c1',
    name: 'ask_user',
    arguments: TOOL_ARGS,
  };
  const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };
  const pending = tool.handle(call, ctx);
  await sleep(5);
  const params = transport.lastParams('question.request');
  assert.ok(params !== undefined, '必须发出 question.request 上行通知');
  assert.strictEqual(params['sessionId'], 's1', '通知必须带上会话归属');
  assert.strictEqual(params['timeoutMs'], 60_000, '通知必须带上等待上限（UI 据此倒计时）');
  assert.deepStrictEqual(
    (params['questions'] as AskQuestion[]).map((q) => q.id),
    ['q1', 'q2'],
    '通知必须原样带上本次提问',
  );
  assert.strictEqual(
    (params['questions'] as AskQuestion[])[1]?.multiSelect,
    true,
    '多选标记必须穿过工具参数归一进入通知（UI 据此渲染复选框）',
  );
  assert.strictEqual(bridge.pendingQuestionCount(), 1, '发出后应有一条挂起提问');
  const ack = bridge.respondQuestion({
    requestId: requestIdOf(),
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['X', 'Y'], custom: '补充' },
    ],
  });
  assert.deepStrictEqual(ack, { ok: true });
  const result = await pending;
  assert.strictEqual(result.ok, true);
  const parsed = JSON.parse(result.output ?? '{}') as { answers: AskAnswer[] };
  assert.deepStrictEqual(parsed.answers[0]?.selected, ['A']);
  assert.deepStrictEqual(parsed.answers[1]?.selected, ['X', 'Y']);
  assert.strictEqual(parsed.answers[1]?.custom, '补充');
  assert.strictEqual(bridge.pendingQuestionCount(), 0, '兑现后不得残留挂起条目');
});

test('② 提问上行超时按「未拿到回答」fail-soft 兑现', async () => {
  const { bridge, transport } = build(40);
  const started = Date.now();
  const answers = await bridge.questionPort().ask(QUESTIONS);
  assert.ok(Date.now() - started >= 30, '应在超时后兑现');
  assert.deepStrictEqual(
    answers.map((answer) => answer.id),
    ['q1', 'q2'],
    '超时仍须逐题作答（同序同长），否则模型面 JSON 与提问对不上',
  );
  assert.strictEqual(answers[0]?.selected.length, 0);
  assert.match(answers[0]?.custom ?? '', /未配置交互式用户回答/, '文案须与无人值守默认同源');
  assert.strictEqual(bridge.pendingQuestionCount(), 0, '超时后不得残留挂起条目');
  assert.strictEqual(transport.sent.length, 1, '提问请求必须已上行');
});

test('③ 答案不合法一律拒绝且保留挂起（客户端可改正后重提）', async () => {
  const { bridge, requestIdOf } = build(60_000);
  const pending = bridge.questionPort().ask(QUESTIONS);
  await sleep(5);
  const requestId = requestIdOf();
  const cases: [string, unknown][] = [
    ['answers 不是数组', { q1: 'A' }],
    ['题目 id 不在本次提问里', [{ id: 'nope', selected: [] }]],
    ['选择了未提供的选项', [{ id: 'q1', selected: ['Z'] }]],
    ['单选题给了两个选项', [{ id: 'q1', selected: ['A', 'B'] }]],
    ['custom 超长', [{ id: 'q1', selected: [], custom: 'x'.repeat(4001) }]],
  ];
  for (const [label, answers] of cases) {
    const ack = bridge.respondQuestion({ requestId, answers }) as {
      ok: boolean;
      error?: string;
    };
    assert.strictEqual(ack.ok, false, `${label} 必须被拒绝`);
    assert.ok((ack.error ?? '').length > 0, `${label} 必须给出可读拒因`);
    assert.strictEqual(bridge.pendingQuestionCount(), 1, `${label} 被拒后挂起必须保留`);
  }
  const unknown = bridge.respondQuestion({ requestId: 'qst_不存在', answers: [] }) as {
    ok: boolean;
    error?: string;
  };
  assert.deepStrictEqual(unknown, { ok: false, error: 'unknown_request' });
  // 改正后同一 requestId 仍可兑现（挂起没被前面几次拒绝吃掉）
  assert.deepStrictEqual(
    bridge.respondQuestion({ requestId, answers: [{ id: 'q1', selected: ['B'] }] }),
    {
      ok: true,
    },
  );
  const answers = await pending;
  assert.deepStrictEqual(answers[0]?.selected, ['B']);
  assert.deepStrictEqual(answers[1]?.selected, [], '未作答的题按空选择回填');
});

test('④ 客户端全部断开 ⇒ 挂起提问立即按 fail-soft 收尾', async () => {
  const { bridge } = build(60_000);
  const pending = bridge.questionPort().ask(QUESTIONS);
  await sleep(5);
  assert.strictEqual(bridge.pendingQuestionCount(), 1);
  assert.strictEqual(bridge.denyAllPending('测试：页面关闭'), 1, '应一并收尾挂起提问');
  const answers = await pending;
  assert.match(answers[0]?.custom ?? '', /未配置交互式用户回答/);
  assert.strictEqual(bridge.pendingQuestionCount(), 0);
  assert.strictEqual(bridge.denyAllPending('再调一次'), 0, '无挂起时返回 0（幂等）');
});
