/**
 * 前缀复用率**进入事件日志**的接线判据（2026-10-15）。
 *
 * 背景：`StepContextBuilder.measurePrefixReuse` 自 2026-10-03 起就在真实请求路径上量前缀复用率，
 * 但它当时**只打一条 debug 日志** —— 容量面板因此拿不到这个信号，"缓存命中率低"只能显示一个数字、
 * 说不出原因（看板 §8.11 登记的那条遗留）。本判据钉住"信号真的到了事件日志里"。
 *
 * 三条（真跑 Agent 回合，不是函数级自证）：
 *  1. **接线**：`model` 事件的上下文快照里必须真的带上 `prefixReuseRatio`；
 *  2. **首次请求无基准**：第一条带快照的事件**不得**有该字段——写 0 会被读成"前缀被完全改写"；
 *  3. **口径一致**：快照里的值必须与 `PrefixStability.prefixReuse`（唯一实现）对该步
 *     "上一次实际发出的 messages"与"本次"算出的值**逐位相同**；否则面板给的理由与真实请求无关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent } from '../../src/core/agent.ts';
import { ScriptedModel, type ScriptStep } from '../../src/core/scriptedModel.ts';
import { PrefixStability } from '../../src/context/prefixStability.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { Runtime } from '../../src/composition/runtime.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';
import { RecordingModel } from '../helpers/recordingModel.ts';
import type { EventPort } from '../../src/ports/runtime/eventPort.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.ts';

/** 快照里本判据关心的那一个字段（只为类型收窄，不复制端口契约）。 */
interface SnapshotWithPrefix {
  readonly prefixReuseRatio?: number;
}

/** 采集型事件端口：留下全部广播事件。 */
class CapturingEventPort implements EventPort {
  /** 适配器名（端口契约要求）。 */
  public readonly name = 'capturing';
  /** 收到的全部事件（按广播序）。 */
  public readonly seen: SessionEvent[] = [];

  /**
   * 记录一次广播。
   * @param event 会话事件。
   * @returns 无返回值。
   */
  public emit(event: SessionEvent): void {
    this.seen.push(event);
  }
}

/**
 * 给脚本模型补上确定性 usage。
 *
 * **为什么必须有它**：生产里 `model` 事件只在模型上报了 usage 时落盘
 * （`StepRunner.run` 的 `if (output.usage !== undefined)`），而 `ScriptedModel` 不报 usage ⇒
 * 没有装饰器就一条事件都没有，判据会**空洞通过**（"没接线"与"没数据"看起来一样）。
 */
class UsageReportingModel implements ModelPort {
  /** 端口名（与内层一致）。 */
  public readonly name: string;

  /**
   * @param inner 被装饰的模型。
   * @param promptTokens 每次调用上报的输入 token 数（确定性）。
   */
  public constructor(
    private readonly inner: ModelPort,
    private readonly promptTokens = 1_000,
  ) {
    this.name = inner.name;
  }

  /**
   * 转发请求并补上 usage。
   * @param request 模型请求。
   * @returns 内层产出 + 确定性 usage。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const output = await this.inner.generate(request);
    return {
      ...output,
      usage: {
        promptTokens: this.promptTokens,
        completionTokens: 1,
        totalTokens: this.promptTokens + 1,
        cachedPromptTokens: 0,
      },
    };
  }
}

/**
 * 跑一个多步脚本回合，返回"组装上下文"形态的请求与全部事件。
 *
 * 语料为什么抄真实源码：repo-map 是逐轮变化的尾部动态段，空工作区里它为空 ⇒
 * 前缀复用率恒为 1，判据会退化成"只验了没接线的那一半"。抄 24 个真实文件后动态段真的存在
 * （与 `prefixReuseGuard.test.ts` 同一手法，成本只有百毫秒级）。
 * @param steps 工具步数。
 * @returns 请求序列、事件序列、工作区路径。
 */
async function runTurn(steps: number): Promise<{
  readonly requests: readonly ModelRequest[];
  readonly events: readonly SessionEvent[];
  readonly workspace: string;
}> {
  const workspace = mkdtempSync(join(tmpdir(), 'omni-prefix-snapshot-'));
  const sourceRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'src',
    'context',
  );
  for (const name of readdirSync(sourceRoot).slice(0, 24)) {
    copyFileSync(join(sourceRoot, name), join(workspace, name));
  }
  const script: readonly ScriptStep[] = [
    ...Array.from({ length: steps }, (_unused, i) => ({
      toolCalls: [{ id: `c${String(i)}`, name: TOOL_NAMES.glob, arguments: { pattern: '*.ts' } }],
    })),
    { text: '完成' },
  ];
  const model = new RecordingModel(new UsageReportingModel(new ScriptedModel(script, '收尾')));
  const port = new CapturingEventPort();
  const config = ConfigFactory.build({
    workspaceRoot: workspace,
    maxSteps: steps + 2,
    model,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: port,
  });
  await new Agent(Runtime.createRuntime(config)).runTask('找点文件');
  // 只取"组装上下文"形态的请求（恒 ≥2 条消息）；回合末的记忆抽取等辅助调用只有单条提示。
  const requests = model.requests.filter((request) => request.messages.length >= 2);
  return { requests, events: port.seen, workspace };
}

test('前缀复用率接线：快照必须带实测值，且与 PrefixStability 逐位一致', async () => {
  const { requests, events, workspace } = await runTurn(3);
  try {
    assert.ok(
      requests.length >= 3,
      `至少要有 3 次组装上下文请求才有相邻对比，实得 ${String(requests.length)}（过滤失配会空洞通过）`,
    );
    const snapshots = events.filter(
      (event) =>
        event.type === 'model' && (event.payload as { context?: unknown }).context !== undefined,
    );
    assert.strictEqual(
      snapshots.length,
      requests.length,
      '每条组装上下文请求都应落一条带快照的 model 事件（数量对不上说明判据的取样口径已经漂了）',
    );
    // ① 首次请求没有可比基准：字段必须缺省（写 0 会被读成"前缀被完全改写"）。
    const first = (snapshots[0]?.payload as { context: SnapshotWithPrefix }).context;
    assert.strictEqual(
      'prefixReuseRatio' in first,
      false,
      '首次请求不得带 prefixReuseRatio（0 与"没基准"语义相反）',
    );
    // ② 口径一致：工厂里记的 messages 必须与快照里的比值同源。
    for (let i = 1; i < requests.length; i += 1) {
      const previous = requests[i - 1];
      const current = requests[i];
      assert.ok(previous !== undefined && current !== undefined);
      const expected = Number(
        PrefixStability.prefixReuse(
          JSON.stringify(previous.messages),
          JSON.stringify(current.messages),
        ).toFixed(4),
      );
      const actual = (snapshots[i]?.payload as { context: SnapshotWithPrefix }).context
        .prefixReuseRatio;
      assert.strictEqual(
        actual,
        expected,
        `第 ${String(i + 1)} 次请求的快照前缀复用率必须等于 PrefixStability 的实测值` +
          '（否则面板给出的理由与真正发出的请求无关）',
      );
      assert.ok(
        actual !== undefined && actual >= 0 && actual <= 1,
        `复用率必须落在 [0,1]，实得 ${String(actual)}`,
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
