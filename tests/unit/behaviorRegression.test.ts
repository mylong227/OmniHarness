/**
 * **最小行为回归守卫**（G1a，2026-10-03 第六轮）。
 *
 * ## 为什么要有这个文件
 *
 * 删除跑分/评测子系统后，检索质量、工具暴露、前缀复用等**行为面**失去了机械判据；
 * 而本仓唯一还活着的"行为探测器"是散落在 `.omniharness/`（未入库）里的临时脚本。
 * 本文件把其中**最便宜、最不依赖语料与模型**的一类固化成入库判据：
 * 用 `ScriptedModel`（确定性、零 key、离线）驱动**真实 Agent 主循环与真实运行时**，
 * 断言**行为不变量**（不是分数）——这类不变量一旦被破坏，就是可观察的功能回归：
 *
 *  1. 工具调用**顺序与配对**：模型请求的工具按 model 顺序落事件，且每个 `tool_call` 必有配对的
 *     `tool_result`（缺配对会让上游 HTTP 400，是本仓重点治理过的失败形态）；
 *  2. 落盘**不丢不重**：回合结束后持久化事件与内存事实一致（id 唯一、配对完整、顺序保持）——
 *     这是"重进会话看不到历史"那类事故的直接护栏；
 *  3. 工具门禁**真起作用**：被审批拒绝的写类工具不得产生文件，且失败要如实回到模型；
 *  4. 透传**接线**：`TurnRunner.rewindCompactionState()` 必须真的调到 `StepRunner`（G4-L4 的接线面）。
 *
 * **口径**：断言的是"行为是否仍成立"，不是"效果是否更好"。改进类结论仍需自建对照
 * （见 `docs/ARCHITECTURE_UPGRADE_2026-10.md` §4 的 G1b）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '../../src/core/agent.js';
import { TurnRunner } from '../../src/core/turnRunner.js';
import { ScriptedModel, type ScriptStep } from '../../src/core/scriptedModel.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PlanApproval } from '../../src/adapters/approval/planApproval.js';
import { MemoryPlan } from '../../src/adapters/plan/memoryPlan.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { StepRunner } from '../../src/core/stepRunner.js';

/**
 * 记录每次模型请求的**装饰器**：行为断言需要看到"模型此刻收到了什么"。
 */
class RecordingModel implements ModelPort {
  /** 端口名（与内层一致，避免影响按模型名分支的逻辑）。 */
  public readonly name: string;
  /** 按调用顺序记录的请求快照（消息数组做浅拷贝，防止后续被就地修改）。 */
  public readonly requests: ModelRequest[] = [];

  /**
   * @param inner 被装饰的真实模型（通常是 `ScriptedModel`）。
   */
  public constructor(private readonly inner: ModelPort) {
    this.name = inner.name;
  }

  /**
   * 记录请求后转发给内层。
   * @param request 本次模型请求。
   * @returns 内层模型的产出。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.requests.push({ ...request, messages: [...request.messages] });
    return this.inner.generate(request);
  }
}

/**
 * 造一个临时工作区。
 * @returns 临时目录绝对路径。
 */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'omni-behavior-'));
}

/**
 * 跑一个脚本回合：真 runtime + 真 Agent 主循环。
 * @param workspaceRoot 工作区根。
 * @param script 脚本步骤。
 * @param maxSteps 步数上限。
 * @returns 运行结果与记录型模型。
 */
async function runScripted(
  workspaceRoot: string,
  script: readonly ScriptStep[],
  maxSteps = 6,
): Promise<{
  result: Awaited<ReturnType<Agent['runTask']>>;
  model: RecordingModel;
  storage: MemoryStorage;
}> {
  const model = new RecordingModel(new ScriptedModel(script, '收尾'));
  const storage = new MemoryStorage();
  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps,
    model,
    storage,
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const result = await new Agent(Runtime.createRuntime(config)).runTask('做点事');
  return { result, model, storage };
}

/**
 * 取事件流里某个类型的载荷集合。
 * @param events 事件数组。
 * @param type 事件类型。
 * @returns 该类型的事件数组。
 */
function eventsOf(events: readonly SessionEvent[], type: string): readonly SessionEvent[] {
  return events.filter((e) => e.type === type);
}

test('① 工具调用顺序与配对：按 model 顺序落事件，且每个 tool_call 必有配对 tool_result', async () => {
  const ws = makeWorkspace();
  try {
    const { result } = await runScripted(ws, [
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.glob, arguments: { pattern: '*.ts' } }] },
      { toolCalls: [{ id: 'c2', name: TOOL_NAMES.glob, arguments: { pattern: '*.md' } }] },
      { text: '完成' },
    ]);
    const calls = eventsOf(result.events, 'tool_call');
    const outs = eventsOf(result.events, 'tool_result');
    assert.strictEqual(calls.length, 2, `应有两次工具调用，实得 ${String(calls.length)}`);
    assert.strictEqual(outs.length, 2, '每个 tool_call 必须落一条配对 tool_result');
    const callIds = calls.map((e) => String((e.payload as { callId?: unknown }).callId));
    assert.deepStrictEqual(callIds, ['c1', 'c2'], '工具必须按 model 声明顺序落事件');
    const outIds = outs.map((e) => String((e.payload as { callId?: unknown }).callId));
    assert.deepStrictEqual(outIds, ['c1', 'c2'], 'tool_result 必须与 tool_call 一一配对且保序');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('② 落盘不丢不重：持久化事件 id 唯一、配对完整、顺序与内存事实一致', async () => {
  const ws = makeWorkspace();
  try {
    const { result, storage } = await runScripted(ws, [
      { toolCalls: [{ id: 'c1', name: TOOL_NAMES.glob, arguments: { pattern: '*.ts' } }] },
      { text: '完成' },
    ]);
    const persisted = await storage.load(result.sessionId);
    const ids = persisted.map((e) => e.id);
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      '持久化事件不得重复（重复＝重放会看到双份历史）',
    );
    assert.ok(persisted.length >= result.events.length - 1, '落盘不应丢事件（允许最后一条在飞）');
    const callIds = eventsOf(persisted, 'tool_call').map((e) =>
      String((e.payload as { callId?: unknown }).callId),
    );
    const outIds = eventsOf(persisted, 'tool_result').map((e) =>
      String((e.payload as { callId?: unknown }).callId),
    );
    assert.deepStrictEqual(outIds, callIds, '落盘后配对关系不得错位（错位会在 resume 时 400）');
    const roles = persisted.map((e) => e.type);
    const firstCall = roles.indexOf('tool_call');
    assert.ok(roles.indexOf('user') >= 0, '持久化里必须有用户指令');
    assert.ok(
      firstCall < 0 || roles.indexOf('user') < firstCall,
      '用户指令必须先于工具调用（顺序语义）',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('③ 工具门禁真起作用：写类工具被拒绝时不得产生文件，且失败如实回到模型', async () => {
  const ws = makeWorkspace();
  try {
    const target = join(ws, 'should-not-exist.txt');
    // plan 模式（只读）下写类工具应被 ToolGate 拦下：这是"门禁是否真接线"的行为判据。
    const model = new RecordingModel(
      new ScriptedModel(
        [
          {
            toolCalls: [
              {
                id: 'w1',
                name: TOOL_NAMES.writeFile,
                arguments: { path: target, content: 'x' },
              },
            ],
          },
          { text: '完成' },
        ],
        '收尾',
      ),
    );
    const config = ConfigFactory.build({
      workspaceRoot: ws,
      maxSteps: 4,
      model,
      storage: new MemoryStorage(),
      approvals: new PlanApproval(),
      sandbox: new PassthroughSandbox(),
      events: new SilentEventPort(),
      plan: new MemoryPlan(),
    });
    const result = await new Agent(Runtime.createRuntime(config)).runTask('写个文件');
    assert.ok(!existsSync(target), 'plan 模式下写类工具必须被拦下（文件不得出现）');
    const outs = eventsOf(result.events, 'tool_result');
    assert.ok(outs.length >= 1, '被拦也必须落 tool_result（模型要能看到失败原因）');
    const first = outs[0]!.payload as { ok?: unknown; error?: unknown };
    assert.strictEqual(first.ok, false, '被门禁拒绝的调用必须如实报 ok:false');
    assert.ok(String(first.error ?? '').length > 0, '拒绝必须带可读原因，不能是空失败');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('④ 透传接线：TurnRunner.rewindCompactionState() 必须真的调到 StepRunner', () => {
  // G4-L4（回滚后重新对齐压缩游标）在 builder 层已有单测；这里钉住"透传没有被静默改坏"。
  let called = 0;
  const fakeStep = {
    rewindCompactionState: (): void => {
      called += 1;
    },
  } as unknown as StepRunner;
  const runner = new TurnRunner(fakeStep, {} as never, 1);
  runner.rewindCompactionState();
  assert.strictEqual(
    called,
    1,
    'TurnRunner 必须把回卷复位透传到 StepRunner（否则回滚后游标仍悬空）',
  );
});
