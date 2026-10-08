/**
 * 提问上行的**接线**判据（2026-10-08 用户报障）。
 *
 * 与 `questionUplink.test.ts` 的分工：那边判端口语义（超时 / 校验 / 断连），这边判**装配是否真的接上**——
 * 模型面 `ask_user` → 会话事件 → `question.request` 通知 → `question.respond` RPC → 作答进工具结果 → 回合继续。
 * 之所以必须单独钉一遍：本次缺陷的形态正是「零件都在、没人接线」（`runServe` 不注入 `userResponder`、
 * AppServer 不注册 `question.respond`），只测端口本身会**全绿而线上照样答不了**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServer } from '../../src/server/core/appServer.js';
import { ServerEventBridge } from '../../src/server/core/serverEventBridge.js';
import { type RpcMessage } from '../../src/server/core/jsonRpc.js';
import type { Transport } from '../../src/server/transport/lineTransport.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import { CliServerCmds } from '../../src/cli/cliServerCmds.js';
import { ArgParser } from '../../src/cli/argParser.js';
import type { ModelOutput, ModelPort } from '../../src/ports/model/model.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 可编程传输（测试双端）。 */
class TestTransport implements Transport {
  /** 已下发的消息。 */
  public readonly sent: RpcMessage[] = [];
  /** 入站回调（由被测 AppServer 注册；本测试用它模拟客户端发请求）。 */
  private callback: ((message: RpcMessage) => void) | undefined;

  /**
   * 记录一条下行消息。
   * @param message RPC 消息
   * @returns 无返回值
   */
  public send(message: RpcMessage): void {
    this.sent.push(message);
  }

  /**
   * 入站订阅。
   * @param callback 入站回调
   * @returns 无返回值
   */
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }

  /**
   * 模拟客户端发送请求（轮询等待响应，容忍异步 handle）。
   * @param method 方法名
   * @param params 参数
   * @param id 请求 id
   * @returns 响应消息（超时返回 result 为 undefined 的占位）
   */
  public async receive(
    method: string,
    params: Record<string, unknown>,
    id = 1,
  ): Promise<RpcMessage> {
    await this.callback?.({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = this.sent.find((message) => 'id' in message && message.id === id);
      if (response !== undefined) {
        return response;
      }
      await sleep(5);
    }
    return { jsonrpc: '2.0', id, result: undefined };
  }

  /**
   * 已发送的指定方法通知。
   * @param method 通知方法名
   * @returns 命中消息
   */
  public notifications(method: string): RpcMessage[] {
    return this.sent.filter((message) => 'method' in message && message.method === method);
  }
}

/** 首步提问、次步收尾的脚本模型（无需凭据）。 */
class AskFirstModel implements ModelPort {
  /** 适配器名。 */
  public readonly name = 'scripted-ask';
  /** 已调用次数。 */
  private calls = 0;

  /**
   * 生成响应：第一次抛结构化提问，之后给最终文本。
   * @returns 模型输出
   */
  public async generate(): Promise<ModelOutput> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        toolCalls: [
          {
            id: 'scripted_call_1',
            name: TOOL_NAMES.askUser,
            arguments: {
              questions: [
                {
                  id: 'scope',
                  header: '确认范围',
                  question: '这次做哪一种？',
                  options: [{ label: '全做' }, { label: '只做一半' }],
                },
              ],
            },
          },
        ],
      };
    }
    return { text: '已按你的选择继续' };
  }
}

/**
 * 建一台带提问上行的 AppServer（与 `runServe` 同形：桥先行 + `userResponder`/`events` 注入 + 桥实例复用）。
 * @param toolEvents 工具侧事件端口（缺省 = 新接线：走服务端桥；传 `SilentEventPort` 即复现旧缺陷）。
 * @returns server、传输与上行桥
 */
function buildServer(toolEvents?: EventPort): {
  server: AppServer;
  transport: TestTransport;
  events: ServerEventBridge;
} {
  const transport = new TestTransport();
  const events = new ServerEventBridge({ transport, questionTimeoutMs: 60_000 });
  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 8,
    model: new AskFirstModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: toolEvents ?? events.eventPort(),
    userResponder: events.questionPort(),
  });
  const server = new AppServer({
    config,
    transport,
    eventBridge: events,
    modelOverrideEnabled: false,
  });
  return { server, transport, events };
}

/**
 * 轮询等待一个条件成立。
 * @param probe 取值函数（未就绪返回 undefined）
 * @param timeoutMs 上限
 * @returns 命中的值
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = probe();
    if (hit !== undefined) return hit;
    await sleep(5);
  }
  throw new Error('等待条件超时');
}

/**
 * 跑一次「模型提问 → 客户端作答」的完整回合。
 * @param transport 测试传输
 * @returns 本回合收到的 thread.event 类型列表（按到达顺序）
 */
async function runAskTurn(transport: TestTransport): Promise<string[]> {
  const run = transport.receive('turns.run', { prompt: '问我一个问题' }, 1);
  const params = (await waitFor(() => {
    const hit = transport.notifications('question.request')[0];
    return hit === undefined ? undefined : (hit as { params: Record<string, unknown> }).params;
  })) as { requestId: string };
  (await transport.receive(
    'question.respond',
    { requestId: params.requestId, answers: [{ id: 'scope', selected: ['全做'] }] },
    2,
  )) as { result: { ok: boolean } };
  await run;
  return transport
    .notifications('thread.event')
    .map(
      (message) =>
        (message as unknown as { params: { event: { type: string } } }).params.event.type,
    );
}

test('接线：turns.run 触发 question.request，question.respond 的作答进入工具结果并让回合继续', async () => {
  const { transport, events } = buildServer();
  const run = transport.receive('turns.run', { prompt: '问我一个问题' }, 1);
  const params = (await waitFor(() => {
    const hit = transport.notifications('question.request')[0];
    return hit === undefined ? undefined : (hit as { params: Record<string, unknown> }).params;
  })) as {
    requestId: string;
    sessionId: string;
    questions: { id: string }[];
    timeoutMs: number;
  };
  assert.strictEqual(params.questions[0]?.id, 'scope');
  assert.strictEqual(params.timeoutMs, 60_000, '通知必须带等待上限（UI 据此倒计时）');
  const threadId = (
    transport.notifications('thread.event')[0] as unknown as {
      params: { threadId: string };
    }
  ).params.threadId;
  assert.strictEqual(params.sessionId, threadId, '提问必须归属到发起它的会话');

  const ack = (await transport.receive(
    'question.respond',
    { requestId: params.requestId, answers: [{ id: 'scope', selected: ['全做'] }] },
    2,
  )) as { result: { ok: boolean } };
  assert.strictEqual(ack.result.ok, true, '合法作答必须被受理');

  const finished = (await run) as { result?: { finalText?: string } };
  assert.strictEqual(finished.result?.finalText, '已按你的选择继续', '作答后回合必须继续跑完');
  const results = transport
    .notifications('thread.event')
    .map(
      (message) =>
        (
          message as unknown as {
            params: { event: { type: string; payload?: { output?: string } } };
          }
        ).params.event,
    )
    .filter((event) => event.type === 'tool_result');
  assert.ok(
    (results.at(-1)?.payload?.output ?? '').includes('全做'),
    '用户所选标签必须作为工具结果回灌给模型',
  );
  assert.strictEqual(events.pendingQuestionCount(), 0, '作答后不得残留挂起提问');
  // 事件接线（2026-10-08 修）：`ask_user` 在 `ConfigFactory.build` 期捕获的事件端口必须是本桥，
  // 否则对话流里那块「提问」根本到不了客户端（旧装配给的是 `SilentEventPort`）。
  const types = transport
    .notifications('thread.event')
    .map(
      (message) =>
        (message as unknown as { params: { event: { type: string } } }).params.event.type,
    );
  assert.ok(types.includes('question'), '工具发出的 question 事件必须到达客户端');
});

test('事件接线反例：工具侧事件端口不接客户端 ⇒ 客户端收不到 question 事件', async () => {
  // 修前形态的判据：`events` 只给控制台/静默（旧 serve 装配 = `args.events` 缺省的 console 出口），
  // 同一回合里 `tool_result` 照常到达，而 `question` 事件**永久缺席**（对话流里那块「提问」没了）。
  // 这条反例说明前一条判据为什么会红/绿——避免「零件都在、没人接线」这类缺陷再次静默通过。
  const { transport } = buildServer(new SilentEventPort());
  const types = await runAskTurn(transport);
  assert.ok(types.includes('tool_result'), '反例里工具结果仍应到达（否则判据不成立）');
  assert.ok(!types.includes('question'), '未接客户端时 question 事件不得出现（这就是被修的缺陷）');
});

test('接线：serve 的配置里回答器必须是提问上行端口（而不是控制台/放弃作答）', async () => {
  // 判据的着力点：`ConfigFactory.build` 期捕获的 `userResponder` 若仍是 `ConsoleUserResponder`
  // （TTY）/`DefaultUserResponder`（非 TTY），Web 端就永远答不了——这正是 2026-10-08 的线上形态。
  const cmds = new CliServerCmds();
  const args = ArgParser.parseArgs([
    '--prompt',
    'serve',
    '--model-adapter',
    'mock',
    '--workspace',
    tempWorkspace(),
  ]);
  assert.ok(args !== undefined, 'serve 参数必须可解析');
  const upstream = await cmds.buildServeUpstream(args, undefined, undefined);
  const responder = upstream.config.userResponder;
  assert.strictEqual(responder.name, 'server', 'serve 必须把提问接到上行端口');
  // 事件端口：`--events` 缺省就是 controller console，故 serve 下应是 console 与桥的**组合**
  // （控制台可读 + 客户端实时流）；要点是**桥必须在其中**——旧装配根本没有它。
  assert.match(
    upstream.config.events.name,
    /(^|\+)server$/,
    'serve 必须把工具侧事件接到上行桥（旧装配只有控制台/静默，UI 看不到 question/todo/plan）',
  );
  assert.ok(
    !upstream.config.events.name.includes('silent'),
    'serve 不得让工具侧事件只进静默端口（那等于客户端永远收不到）',
  );

  // 行为指纹：经「配置里的回答器」发起提问 ⇒ 桥里必须真的出现一条挂起提问（同一实例）。
  const pending = responder.ask([{ id: 'q1', question: '选哪个？' }], { sessionId: 's1' });
  await sleep(10);
  assert.strictEqual(
    upstream.events.pendingQuestionCount(),
    1,
    '配置里的回答器与本桥必须是同一个提问上行端口（否则作答会送进空表）',
  );
  upstream.events.denyAllPending('测试收尾');
  const answers = await pending;
  assert.match(answers[0]?.custom ?? '', /未配置交互式用户回答/, '断连收尾沿用 fail-soft 文案');
});
