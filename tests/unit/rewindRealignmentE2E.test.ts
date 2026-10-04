/**
 * **回卷后压缩游标重新对齐**的接线判据（G1b-c2，2026-10-04 第二十九轮）。
 *
 * ## 它补的是 G1b-c 缺的那颗牙
 *
 * G1b-c 的两条判据（`rewindCompactionCursor.test.ts`）都不区分 `Agent.registerRewinder` 里的显式
 * `runnerOf()?.rewindCompactionState()`——把那一行删掉它们照样绿：压缩器面对"`previous` 与当前消息列表
 * 不一致"会安全重折，陈旧游标不导致错误**内容**。本文件换一个**能观测到差异**的夹具：
 *
 * 1. **对照 run**：真实运行时里自然发生一次**真折叠**（写回 `OMNI_COMPACTION_V1` 游标事件 + 摘要哨兵 `_v1`）。
 * 2. **回卷 run**：经**真实回卷通路**（`LiveSessionRewindRegistry.rewind`，即
 *    `CheckpointManager.rollback` 与在跑会话回卷共用的入口）把日志**精确截断到游标事件之前**
 *    ——只截掉游标事件本身。投影因此逐字节不变（游标事件本就不投影），这正是 G1b-c 的
 *    请求体判据看不见差异的原因；差异只在**构建器的内存游标**上。
 * 3. 主判据：回卷后的下一次构建**不得复用回滚前内存里的旧游标**，而必须承认
 *    "截断后的日志里没有游标"——重新折叠（新摘要 `_v2`、摘要 LLM 调用 +1）并把新游标事件
 *    重新落日志（崩溃恢复面：重启后的实例不必再付一次摘要调用）。
 *
 * ## 变异（有牙齿的证据）
 *
 * 删掉 `agent.ts` 回卷回调里的 `runnerOf()?.rewindCompactionState()` ⇒ 陈旧游标 C1 对截断后日志
 * 依然有效（折叠点前缀逐字节未变、指纹匹配）⇒ 压缩器走游标快路径复用 `_v1`：
 * 摘要调用不增加、末次请求仍带 `_v1` 无 `_v2`、日志里再无游标事件——三条断言同时变红。
 *
 * ## 夹具机制（为何两段式、触发点为何自定位）
 *
 * 真折叠发生在第几步由预算与"上下文压缩"通知事件的投影位置共同决定，**不硬编码**：
 * 第一段 run 跑出真实事件流，从中标定游标事件的**精确下标**（回卷 size）；第二段 run 用同一脚本
 * （回卷前逐事件确定一致），模型包装器在**首次摘要调用之后的第一个步骤调用点**触发回卷——
 * 该时刻游标事件必然是日志最后一条（折叠写回与模型调用之间不产生事件），截到该下标即"只删游标"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { ScriptedModel } from '../../src/core/scriptedModel.js';
import type { ScriptStep } from '../../src/core/scriptedModel.js';
import { LiveSessionRewindRegistry } from '../../src/core/liveSessionRewindRegistry.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 压缩游标事件前缀（`ContextCompactor` 的折叠点标记）。 */
const COMPACTION_MARKER = 'OMNI_COMPACTION_V1';

/** 压缩器摘要请求的提示词特征（`ContextCompactor` 的 `SUMMARY_TEMPLATE` 开头）。 */
const COMPACTOR_PROMPT_MARK = '对话历史压缩器';

/** 记忆蒸馏请求的提示词特征（回合末自动沉淀，不属于步骤调用）。 */
const EXTRACTOR_MARK = '长期记忆';

/** 摘要哨兵：带序号（`_v1`/`_v2`）以区分"复用旧摘要"与"重新折叠"。 */
const SUMMARY_SENTINEL = 'REALIGN_SENTINEL';

/** 单次 run 的会话事件流与请求观测。 */
interface RunOutcome {
  /** 模型收到的全部请求体（含摘要/蒸馏请求）。 */
  readonly bodies: readonly string[];
  /** 会话事件流（run 结束时的内存日志快照）。 */
  readonly events: readonly SessionEvent[];
  /** 压缩器摘要调用次数。 */
  readonly summaries: number;
  /** 步骤调用次数（不含摘要/蒸馏）。 */
  readonly stepCalls: number;
  /** 回卷是否命中在跑会话（未触发回卷的 run 为 undefined）。 */
  readonly rewindHit: boolean | undefined;
}

/** Agent 引用容器：模型构造在 Agent 之前，回卷触发时经它取在跑会话 id。 */
interface AgentHolder {
  agent?: Agent;
}

/**
 * 记录请求体并按需触发回卷的模型包装器。
 *
 * 摘要请求返回带序号哨兵；步骤调用（非摘要/蒸馏）里，**首次摘要调用之后的第一步**执行回卷——
 * 该时刻折叠刚写回游标事件，它是日志最后一条，截到标定下标即"只删游标事件"。
 */
class CapturingRewindModel implements ModelPort {
  /** 端口名（与内层一致）。 */
  public readonly name: string;

  /** 请求体快照（JSON 字符串，按调用顺序）。 */
  public readonly bodies: string[] = [];

  /** 压缩器摘要调用次数。 */
  public summaries = 0;

  /** 步骤调用次数（不含摘要/蒸馏请求）。 */
  public stepCalls = 0;

  /** 回卷是否命中在跑会话（未触发为 undefined）。 */
  public rewindHit: boolean | undefined;

  /**
   * @param inner 内层脚本模型。
   * @param rewind 回卷触发参数（缺省 = 不触发，对照 run）。
   */
  public constructor(
    private readonly inner: ModelPort,
    private readonly rewind?:
      | {
          /** 回卷目标长度（保留前 `size` 条事件）。 */
          readonly size: number;
          /** 取在跑会话 id（惰性：Agent 在模型之后构造）。 */
          readonly sessionIdOf: () => string;
        }
      | undefined,
  ) {
    this.name = inner.name;
  }

  /**
   * 记录后转发；摘要请求返回带序号哨兵，步骤调用按需触发一次回卷。
   * @param request 模型请求。
   * @returns 摘要或内层产出。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const body = JSON.stringify(request.messages);
    this.bodies.push(body);
    if (body.includes(COMPACTOR_PROMPT_MARK)) {
      this.summaries += 1;
      return { text: `${SUMMARY_SENTINEL}_v${String(this.summaries)}（若干次 shell 调用）` };
    }
    if (!body.includes(EXTRACTOR_MARK)) {
      this.stepCalls += 1;
      if (this.rewind !== undefined && this.rewindHit === undefined && this.summaries > 0) {
        this.rewindHit = await LiveSessionRewindRegistry.sharedRegistry().rewind(
          this.rewind.sessionIdOf(),
          this.rewind.size,
        );
      }
    }
    return this.inner.generate(request);
  }
}

/**
 * 构造脚本：三小步（折叠前日志低于预算）→ 一大步（把投影顶过预算）→ 四小步 + 收尾。
 * 真折叠发生在"上下文压缩"通知事件停住折叠边界之后的首次超预算构建（自定位，不硬编码）。
 * @returns 脚本步。
 */
function buildScript(): readonly ScriptStep[] {
  const big = 'x'.repeat(8000);
  const shell = (id: string, command: string): ScriptStep => ({
    toolCalls: [{ id, name: TOOL_NAMES.shell, arguments: { command } }],
  });
  return [
    shell('c-pre0', 'echo ok0'),
    shell('c-pre1', 'echo ok1'),
    shell('c-pre2', 'echo ok2'),
    shell('c-big', `echo B1-${big}`),
    shell('c-post', 'echo post-fold'),
    shell('c-tail', 'echo after-fold'),
    shell('c-more1', 'echo more-1'),
    shell('c-more2', 'echo more-2'),
    { text: '收尾完成' },
  ];
}

/**
 * 从请求体序列取**最后一个步骤请求**（剔除压缩器摘要与记忆蒸馏请求）。
 * @param bodies 全部请求体。
 * @returns 末次步骤请求体；不存在为 undefined。
 */
function lastStepBody(bodies: readonly string[]): string | undefined {
  return bodies
    .filter((body) => !body.includes(COMPACTOR_PROMPT_MARK) && !body.includes(EXTRACTOR_MARK))
    .at(-1);
}

/**
 * 数事件流里的压缩游标事件（`system` 事件且内容以前缀开头；"上下文压缩"通知不算）。
 * @param events 会话事件流。
 * @returns 游标事件条数。
 */
function markerCount(events: readonly SessionEvent[]): number {
  return events.filter((event) => {
    if (event.type !== 'system') {
      return false;
    }
    const content = (event.payload as { content?: unknown }).content;
    return typeof content === 'string' && content.startsWith(COMPACTION_MARKER);
  }).length;
}

/**
 * 跑一遍会话（真实运行时 + 脚本模型）。
 * @param rewindSize 回卷目标长度（缺省 = 对照 run，不触发回卷）。
 * @returns 请求观测、事件流、摘要调用数与回卷命中标记。
 */
async function runSession(rewindSize?: number): Promise<RunOutcome> {
  process.env.OMNI_REPO_MAP = '0';
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-g1bc2-'));
  try {
    const holder: AgentHolder = {};
    const capturing = new CapturingRewindModel(
      new ScriptedModel(buildScript(), '收尾完成'),
      rewindSize === undefined
        ? undefined
        : {
            size: rewindSize,
            // Agent 在模型之后构造，经容器惰性取在跑会话 id（本测试单会话）。
            sessionIdOf: () => holder.agent?.runningSessionIds()[0] ?? '',
          },
    );
    const config = ConfigFactory.build({
      workspaceRoot,
      maxSteps: 20,
      model: capturing,
      storage: new MemoryStorage(),
      approvals: new AutoApproval(),
      sandbox: new PassthroughSandbox(),
      events: new SilentEventPort(),
      // 大步输出（约 2000 token）把投影顶过预算；小步保持折叠前不触发。
      compactionMaxTokens: 1000,
    });
    const agent = new Agent(Runtime.createRuntime(config));
    holder.agent = agent;
    const result = await agent.runTask('回卷对齐判据：请一直跑下去');
    return {
      bodies: capturing.bodies,
      events: result.events,
      summaries: capturing.summaries,
      stepCalls: capturing.stepCalls,
      rewindHit: capturing.rewindHit,
    };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test('端到端：回卷只截掉游标事件后，下一次构建必须重新对齐（重折 + 游标重新落盘）', async () => {
  // 第一段：对照 run —— 真折叠自然发生，标定游标事件的精确下标（同一脚本逐事件确定一致）。
  const control = await runSession();

  // ① 对照组形状：真折叠确实发生了（恰一次摘要调用 + 日志里恰一条游标事件）。
  assert.strictEqual(
    control.summaries,
    1,
    `对照组应恰有一次真折叠（实测 ${String(control.summaries)} 次）`,
  );
  assert.strictEqual(markerCount(control.events), 1, '对照组日志应恰有一条游标事件');
  const markerIndex = control.events.findIndex((event) => {
    const content = (event.payload as { content?: unknown }).content;
    return (
      event.type === 'system' &&
      typeof content === 'string' &&
      content.startsWith(COMPACTION_MARKER)
    );
  });
  assert.ok(markerIndex > 0, '对照组里找不到游标事件（夹具破坏）');
  // 哨兵机制自证：游标事件载荷里带着 _v1 哨兵（否则后面对"_v1 消失"的断言是空的）。
  const markerPayload = JSON.stringify(
    (control.events[markerIndex] as { payload: unknown }).payload,
  );
  assert.ok(markerPayload.includes(`${SUMMARY_SENTINEL}_v1`), '游标事件载荷应包含 _v1 哨兵');

  // 第二段：同一脚本；模型在"首次摘要调用后的第一个步骤调用点"经真实注册表回卷到标定下标
  // （= 只删游标事件本身）。
  const rewound = await runSession(markerIndex);

  // ② 回卷确实命中在跑会话，且旧游标（含 _v1）确被截掉。
  assert.strictEqual(
    rewound.rewindHit,
    true,
    '回卷应命中在跑会话（登记表 → registerRewinder 通路）',
  );
  assert.strictEqual(markerCount(rewound.events), 1, '回卷 run 末日志应恰有一条（新写的）游标事件');

  // ③ 主判据：回卷后必须重新折叠（新摘要调用 +1），不得走旧游标快路径。
  assert.ok(
    rewound.summaries >= 2,
    `回卷截掉游标后应重新折叠（摘要调用 ${String(rewound.summaries)} 次 < 2 ⇒ 复用了回滚前的内存游标）`,
  );

  // ④ 末次步骤请求：带新摘要 _v2、不带被截断的旧摘要 _v1。
  const last = lastStepBody(rewound.bodies);
  assert.ok(last !== undefined, '回卷 run 缺少步骤请求');
  assert.ok(
    last.includes(`${SUMMARY_SENTINEL}_v2`) && !last.includes(`${SUMMARY_SENTINEL}_v1`),
    '回卷后的末次请求应携带重新折叠的 _v2 摘要，而非回滚前的 _v1',
  );

  // ⑤ 崩溃恢复面：重新对齐后新游标必须重新落日志（重启后的实例不必再付一次摘要调用）。
  const newMarker = rewound.events.find((event) => {
    const content = (event.payload as { content?: unknown }).content;
    return (
      event.type === 'system' &&
      typeof content === 'string' &&
      content.startsWith(COMPACTION_MARKER)
    );
  });
  assert.ok(newMarker !== undefined, '回卷后应重新写回游标事件');
  const newMarkerPayload = JSON.stringify((newMarker as { payload: unknown }).payload);
  assert.ok(newMarkerPayload.includes(`${SUMMARY_SENTINEL}_v2`), '新游标事件应携带 _v2 摘要');

  // ⑥ 反真空：两遍都跑满多步（对照组与回卷组同脚本，回卷只删掉一条事件）。
  assert.ok(control.stepCalls >= 8 && rewound.stepCalls >= 8, '请求样本过少');
  assert.strictEqual(
    control.events.length - rewound.events.length,
    0,
    '两遍事件数应一致（回卷只删游标事件，随后新游标补回）',
  );
});
