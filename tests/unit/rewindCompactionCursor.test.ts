/**
 * **回滚与压缩游标**的判据（G1b-c，2026-10-03 第二十六轮）。
 *
 * ## 两条判据各管什么（这是本轮最重要的区分）
 *
 * 1. **端到端对照**（`回滚后最后一次请求不再带旧摘要`）：真实运行时（`ConfigFactory.build` →
 *    `Runtime.createRuntime` → `Agent.runTask`）+ **模型驱动的 `checkpoint`/`rollback` 工具调用**。
 *    控制组（同脚本去掉回滚两步）证明"折叠摘要确实进过请求体"，实验组证明"回滚后不再有它"。
 * 2. **单元级回归守卫**（`回滚截断后不残留旧摘要`）：直接驱动 `StepContextBuilder`，
 *    验证日志被截断后压缩器**安全重折**、不把已截断的折叠点当真。
 *
 * ⚠️ **诚实登记**：这两条**都不区分** `Agent.registerRewinder` 里的显式
 * `runnerOf()?.rewindCompactionState()`（G4-L4 的第四层对齐）——实测把那一行删掉，两条判据**照样绿**。
 * 原因是压缩器面对"`previous` 与当前消息列表不一致"时会安全重折，陈旧游标不导致旧摘要泄漏。
 * 故：本文件的定位是**回归守卫**（回滚不残留旧摘要、不崩、日志确实被截断），
 * 而"L4 显式对齐是否必要"**未被独立证明**，另立 G1b-c2 去找能观测到差异的夹具（见 changeset）。
 *
 * ## 2026-10-11 定性：那条偶发红是**仪器误判**，不是产品缺陷
 *
 * 现象：端到端对照的**实验组**断言偶发红（隔离跑 11 次 1 次、并发多测试进程时 1 次；
 * 纯 CPU 负载 25 次与安静 20 次均 0 次），消息恒为"回滚后的最后一次请求里仍有哨兵"。
 *
 * 取证（一次性探针，未入库）：打印 `CapturingModel` 真正收到的请求体后可见——
 * ① 请求体只有 `{role, content}` 文本，**工具名/调用 id 一次都不出现**（运行时另生成 id，
 *    且本夹具的 `compactionMaxTokens=30` 会把工具轮整体折叠掉）；② **回合末的"记忆抽取器"请求
 *    里带着整段"对话片段"**，其中就含折叠后的旧摘要（哨兵）——见 `src/adapters/memory/memoryExtractor.ts:170`
 *    的提示词 `你是从对话中抽取"长期记忆"的抽取器…`。
 *
 * 根因：旧过滤器 `lastTaskBody` 只排除**压缩器**请求（按 `对话历史压缩器`），于是**抽取器请求被当成"任务请求"**；
 * 而抽取器在回合末触发，它是否恰好排在最后取决于时序 ⇒ 偶发红。**与回滚是否真的截断无关。**
 *
 * 处置：辅助请求过滤器改为**按标记集合排除**（压缩器 + 记忆抽取器），并加一条**仪器自证**
 * （必须真的过滤掉至少一条辅助请求，否则说明过滤器没干活、判据可能又在把辅助请求当任务请求）。
 * **诚实边界**：若将来出现第三种"落在最后"的辅助调用，本判据会假红——失败消息里的自证
 * （任务/辅助条数 + 命中片段）用于一眼分辨，届时把它的提示词前缀加进 `AUXILIARY_PROMPT_MARKS` 即可。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { Agent } from '../../src/core/agent.ts';
import { Runtime } from '../../src/composition/runtime.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { ScriptedModel } from '../../src/core/scriptedModel.ts';
import type { ScriptStep } from '../../src/core/scriptedModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.ts';

/** 压缩标记（`ContextCompactor` 编码的折叠点前缀）。 */
const COMPACTION_MARKER = 'OMNI_COMPACTION_V1';

/** 压缩器摘要请求的提示词特征（`ContextCompactor` 的 `SUMMARY_TEMPLATE` 开头）。 */
const COMPACTOR_PROMPT_MARK = '对话历史压缩器';

/** 摘要哨兵：出现在折叠摘要里 ⇒ "旧摘要还在不在请求里"的观测点。 */
const SUMMARY_SENTINEL = 'SUMMARY_SENTINEL_ALPHA';

/** 记忆抽取器请求的提示词特征（`src/adapters/memory/memoryExtractor.ts:170` 的开头）。 */
const MEMORY_EXTRACTOR_PROMPT_MARK = '你是从对话中抽取';

/**
 * **辅助请求**（非任务请求）的提示词特征集合：它们的正文里会**合理地**出现旧摘要，
 * 故必须从"任务请求"里排除，否则会把"抽取器正在读旧内容"误读成"回滚没截断"。
 *
 * 历史（保留旧文，勿无声改写）：原先只有一个 `lastTaskBody(bodies)`，只按压缩器标记排除。
 * 2026-10-11 定性出：**记忆抽取器**请求（回合末触发）同样带旧摘要，于是它被当成任务请求 ⇒
 * ~3% 偶发假红（详见文件头）。现改为按集合排除，并加仪器自证（见主判据）。
 */
const AUXILIARY_PROMPT_MARKS = [COMPACTOR_PROMPT_MARK, MEMORY_EXTRACTOR_PROMPT_MARK];

/**
 * 记录模型实际收到的请求体，并对压缩器的摘要请求返回带序号哨兵的摘要。
 *
 * 哨兵带序号（`_v1`/`_v2`…）是刻意的：恒定哨兵无法区分"复用旧摘要"与"重新算了一遍摘要"
 * （本判据首版就栽在这里）。
 */
class CapturingModel implements ModelPort {
  /** 端口名（与内层一致）。 */
  public readonly name: string;

  /** 请求体快照（JSON 字符串）。 */
  public readonly bodies: string[] = [];

  /** 摘要调用次数。 */
  public summaries = 0;

  /**
   * @param inner 内层脚本模型。
   */
  public constructor(private readonly inner: ModelPort) {
    this.name = inner.name;
  }

  /**
   * 记录后转发；压缩器的摘要请求返回带序号哨兵的摘要。
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
    return this.inner.generate(request);
  }
}

/**
 * 构造脚本；`withRollback` 是控制组与实验组的**唯一差异**。
 *
 * ## 检查点的位置（2026-10-11 定案，修偶发）
 *
 * 原先放在「第 2 步之后」，理由是想让回滚后仍留一段非空历史。但**第 1 步的输出就有 600 字符**
 * （≈150 token，预算是 30）⇒ 压缩必然在**检查点之前**触发，而"折叠发生在检查点前还是后"取决于
 * 回合/事件的时序 ⇒ 判据偶发红（实测读数：`折叠点位置 [8] / 检查点位置 9` —— 折叠点紧贴检查点之前，
 * 于是回滚到该检查点**合法地**保留了那段摘要，判据却按"必须消失"断言）。
 *
 * 现改为**把检查点放在第一个大步之前**：这样任何折叠都必然发生在检查点**之后** ⇒ 回滚截断时
 * 折叠点必定被截掉，判据的强断言（回滚后不得残留折叠点）才是**确定成立**的。
 * 回滚后仍留非空历史（首条 user + 检查点步 + 回滚步 + 收尾步），原意图不变。
 * 判据侧另有前置条件断言 `rolledBack.markersBeforeCheckpoint === 0` 把这条前提钉死。
 *
 * @param withRollback 是否包含 checkpoint + rollback 两步。
 * @returns 脚本步。
 */
function buildScript(withRollback: boolean): readonly ScriptStep[] {
  const big = 'x'.repeat(600);
  const steps: ScriptStep[] = [];
  if (withRollback) {
    // 检查点**先于**任何大输出 ⇒ 折叠必然在其后（见上方说明）。
    steps.push({
      text: '打个检查点',
      toolCalls: [{ id: 'c-cp', name: TOOL_NAMES.checkpoint, arguments: { label: 'cp1' } }],
    });
  }
  for (let i = 0; i < 6; i += 1) {
    steps.push({
      text: `第 ${String(i + 1)} 步`,
      // 命令必须**各不相同**：完全相同的调用会触发循环守卫（`exact-repeat`）而提前中止回合
      // （首版实测踩到，日志是 `turn.loopguard.abort`）。
      toolCalls: [
        {
          id: `c-sh${String(i)}`,
          name: TOOL_NAMES.shell,
          arguments: { command: `echo step${String(i)}-${big}` },
        },
      ],
    });
  }
  if (withRollback) {
    steps.push({
      text: '回滚到检查点',
      toolCalls: [{ id: 'c-rb', name: TOOL_NAMES.rollback, arguments: {} }],
    });
  }
  steps.push(
    {
      text: '继续干活',
      toolCalls: [
        { id: 'c-post', name: TOOL_NAMES.shell, arguments: { command: 'echo after-rewind' } },
      ],
    },
    { text: '收尾完成' },
  );
  return steps;
}

/**
 * 跑一遍会话。
 *
 * 2026-10-11 加仪器（偶发归因用）：除总数外，还记录**折叠点相对回滚事件的位置**与**回合数**。
 * 为什么必须记：该判据的偶发红有两种完全不同的成因——① 回滚没截断（标记都在回滚**之前**的位置上
 * 仍出现在末条请求里）② 回滚后**重新折叠**了一次（标记出现在回滚**之后**）。旧消息只有总数
 * （`markerEvents`），二者都表现为 1，无法区分。设 `OMNI_FLAKE_DIAG=1` 时打印一行读数。
 *
 * @param withRollback 脚本是否含回滚两步。
 * @returns 捕获到的请求体、事件类型序列、折叠点计数（总数 / 回滚前后）与回滚位置。
 */
async function runSession(withRollback: boolean): Promise<{
  readonly bodies: readonly string[];
  readonly eventTypes: readonly string[];
  readonly markerEvents: number;
  readonly markersBeforeRewind: number;
  readonly markersAfterRewind: number;
  /** 检查点事件**之前**的折叠点数（前置条件：必须为 0）。 */
  readonly markersBeforeCheckpoint: number;
  /** 切点（检查点事件）之后的折叠点数：>0 即"回滚后重新折叠过"。 */
  readonly markersAfterCheckpoint: number;
  /** 折叠点系统事件在事件序列中的下标（定位用）。 */
  readonly markerIndexes: readonly number[];
  /** 检查点事件下标（-1 ＝ 已被截掉）。 */
  readonly checkpointIndex: number;
  readonly rewindIndex: number;
  readonly turns: number;
}> {
  process.env.OMNI_REPO_MAP = '0';
  const capturing = new CapturingModel(new ScriptedModel(buildScript(withRollback), '收尾完成'));
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 20,
    model: capturing,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    // 小预算强制触发压缩：历史一超过 30 token 就折叠（几次大输出足够）。
    compactionMaxTokens: 30,
  });
  const result = await new Agent(Runtime.createRuntime(config)).runTask('长会话：请一直跑下去');
  /** 折叠点系统事件的下标。 */
  const markerIndexes: number[] = [];
  result.events.forEach((event, index) => {
    if (
      event.type === 'system' &&
      String((event.payload as { content?: unknown }).content ?? '').startsWith(COMPACTION_MARKER)
    ) {
      markerIndexes.push(index);
    }
  });
  // 回滚事件：脚本里那次 `rollback` 工具调用（取最后一个，避免把 checkpoint 误当回滚）。
  let rewindIndex = -1;
  result.events.forEach((event, index) => {
    const payload = event.payload as { name?: unknown } | undefined;
    if (String(payload?.name ?? '') === TOOL_NAMES.rollback) {
      rewindIndex = index;
    }
  });
  // **检查点事件**：截断点是它，故两种情形下都应存活 ⇒ 用它当锚点判断折叠点在切点前还是切点后。
  // （回滚事件本身会被截掉：绿跑实测 rewindIndex = -1，单靠它分不出"没截断"与"重折"。）
  let checkpointIndex = -1;
  result.events.forEach((event, index) => {
    const payload = event.payload as { name?: unknown } | undefined;
    if (String(payload?.name ?? '') === TOOL_NAMES.checkpoint) {
      checkpointIndex = index;
    }
  });
  const markersBeforeCheckpoint =
    checkpointIndex < 0 ? 0 : markerIndexes.filter((i) => i < checkpointIndex).length;
  const markersAfterCheckpoint =
    checkpointIndex < 0 ? 0 : markerIndexes.filter((i) => i > checkpointIndex).length;
  const markersBeforeRewind =
    rewindIndex < 0 ? markerIndexes.length : markerIndexes.filter((i) => i < rewindIndex).length;
  const markersAfterRewind =
    rewindIndex < 0 ? 0 : markerIndexes.filter((i) => i > rewindIndex).length;
  const turns = capturing.bodies.length;
  if (process.env.OMNI_FLAKE_DIAG === '1') {
    process.stdout.write(
      `[flake-diag] rollback=${String(withRollback)} 捕获=${String(capturing.bodies.length)} ` +
        `事件=${String(result.events.length)} 折叠点总=${String(markerIndexes.length)} ` +
        `检查点位置=${String(checkpointIndex)} 切点后折叠点=${String(markersAfterCheckpoint)} ` +
        `回滚前=${String(markersBeforeRewind)} 回滚后=${String(markersAfterRewind)} ` +
        `回滚位置=${String(rewindIndex)} 折叠点位置=[${markerIndexes.join(',')}]\n`,
    );
  }
  return {
    bodies: capturing.bodies,
    eventTypes: result.events.map((event) => event.type),
    markerEvents: markerIndexes.length,
    markersBeforeRewind,
    markersAfterRewind,
    markersBeforeCheckpoint,
    markersAfterCheckpoint,
    markerIndexes,
    checkpointIndex,
    rewindIndex,
    turns,
  };
}

test('端到端对照：回滚后不再带旧摘要（日志被截断，不残留折叠点）', async () => {
  const control = await runSession(false);
  const rolledBack = await runSession(true);

  /**
   * 拆出**任务请求**：排除全部辅助请求（压缩器、记忆抽取器——见 `AUXILIARY_PROMPT_MARKS`）。
   *
   * 为什么必须按**集合**排除而不是只排除压缩器（2026-10-11 定性）：记忆抽取器在回合末触发，
   * 它的请求正文就是整段"对话片段"，**含折叠后的旧摘要**；只排除压缩器时它会被当成任务请求，
   * 于是"抽取器正在读旧内容"被误读成"回滚没截断" ⇒ ~3% 偶发假红。详见文件头。
   * @param bodies 捕获到的请求体
   * @returns 任务请求体（保持捕获顺序）
   */
  function taskBodies(bodies: readonly string[]): string[] {
    return bodies.filter((body) => !AUXILIARY_PROMPT_MARKS.some((mark) => body.includes(mark)));
  }

  /** 辅助请求（压缩器 / 记忆抽取器）。 */
  function auxiliaryBodies(bodies: readonly string[]): string[] {
    return bodies.filter((body) => AUXILIARY_PROMPT_MARKS.some((mark) => body.includes(mark)));
  }

  /**
   * 全部捕获体的**分类表**（2026-10-11 补）。
   *
   * 为什么加：本判据的已知假红形态是"**第三种**落在最后的辅助调用"（见文件头诚实边界）——
   * 旧失败消息只给条数与命中片段，看不出那条体到底是谁。把每条体的
   * 「序号 / 字数 / 命中的标记 / 开头 48 字」一次列出，下次复现即可**一眼**判定是仪器漏了标记、
   * 还是产品真的把旧摘要送进了任务请求。
   * @param bodies 捕获到的请求体。
   * @returns 多行分类表。
   */
  function classify(bodies: readonly string[]): string {
    return bodies
      .map((body, index) => {
        const marks = AUXILIARY_PROMPT_MARKS.filter((mark) => body.includes(mark)).join(',');
        const kind = marks === '' ? '任务?' : `辅助(${marks})`;
        return `        [${String(index)}] ${String(body.length)} 字 ${kind} ｜ ${body.slice(0, 48).replace(/\s+/gu, ' ')}`;
      })
      .join('\n');
  }

  // **仪器自证**：过滤器必须真的排除了东西，且**两类辅助请求都要真的出现过**——
  // 尤其是记忆抽取器：它正是 2026-10-11 定性出的误判来源（旧过滤器只排压缩器 ⇒ 抽取器被当任务请求）。
  // 若某类辅助请求在本夹具里压根不触发，这条会先红，而不是让"最后一次任务请求"的读数悄悄失真。
  for (const [label, run] of [
    ['控制组', control],
    ['实验组', rolledBack],
  ] as const) {
    for (const mark of AUXILIARY_PROMPT_MARKS) {
      assert.ok(
        run.bodies.some((body) => body.includes(mark)),
        `${label}：本次捕获里没有出现辅助请求「${mark}」⇒ 本夹具已不再触发它，` +
          `辅助过滤器的覆盖面需要重新核对（捕获 ${String(run.bodies.length)} 条）`,
      );
    }
  }

  // **控制组**：不回滚 ⇒ 折叠摘要一直留在历史里 ⇒ 最后一次任务请求必须还能看到哨兵。
  // 这条不成立，说明观测面看不见压缩，"主判据的没有"就毫无意义。
  assert.ok(
    control.bodies.some((body) => body.includes(SUMMARY_SENTINEL)),
    `控制组（不回滚）里从未出现折叠摘要 ⇒ 观测面无效（请求数 ${String(control.bodies.length)}）`,
  );
  const controlTasks = taskBodies(control.bodies);
  assert.ok(controlTasks.length > 0, '控制组必须至少有一次任务请求（否则下面的断言是空转）');
  const controlLast = controlTasks[controlTasks.length - 1] ?? '';
  assert.ok(
    controlLast.includes(SUMMARY_SENTINEL),
    '控制组的**最后一次任务请求**里应仍带着折叠摘要（不回滚就没有理由丢掉它）',
  );

  // **前置条件**（2026-10-11 修偶发时钉死）：夹具必须保证**折叠点在检查点之后** ——
  // 否则"回滚到检查点"会合法地保留检查点之前那次折叠的摘要，判据的强断言在此前提下才成立。
  // 旧夹具有时把折叠放在检查点之前（实测读数 `折叠点位置 [8] / 检查点位置 9`）⇒ 偶发假红。
  assert.strictEqual(
    rolledBack.markersBeforeCheckpoint,
    0,
    `夹具前提被破坏：回滚的检查点之前已存在折叠点（${String(rolledBack.markersBeforeCheckpoint)} 个）` +
      `⇒ 回滚保留它是**正确**行为，本判据的强断言不再适用。` +
      `折叠点位置 [${rolledBack.markerIndexes.join(',')}] / 检查点位置 ${String(rolledBack.checkpointIndex)}`,
  );
  // **主判据**：回滚之后，最后一次任务请求里不得再有折叠摘要。
  assert.ok(
    rolledBack.bodies.some((body) => body.includes(SUMMARY_SENTINEL)),
    '实验组里也出现过折叠摘要（否则"回滚后没有"只是因为压根没压缩过）',
  );
  const rolledBackTasks = taskBodies(rolledBack.bodies);
  // **防空转**：过滤后为空 ⇒ 下面的"不包含"恒真，那等于判据自己失灵还报绿。
  assert.ok(
    rolledBackTasks.length > 0,
    `必须至少有一次任务请求（实际捕获 ${String(rolledBack.bodies.length)} 条，全部是辅助请求？）`,
  );
  const rolledBackLast = rolledBackTasks[rolledBackTasks.length - 1] ?? '';
  for (const needle of [SUMMARY_SENTINEL, COMPACTION_MARKER]) {
    // 失败时**自证**：把命中处前后各 120 字打进消息，用于区分"真残留"与"未分类的辅助请求"。
    const hit = rolledBackLast.indexOf(needle);
    const excerpt =
      hit < 0
        ? '（未命中，不应到这里）'
        : `…${rolledBackLast.slice(Math.max(0, hit - 120), hit + needle.length + 120)}…`;
    assert.ok(
      hit < 0,
      `回滚后的最后一次请求里仍有 ${needle} ⇒ 回滚没把折叠点截掉` +
        `（任务请求 ${String(rolledBackTasks.length)} 条 / 辅助请求 ${String(auxiliaryBodies(rolledBack.bodies).length)} 条 / ` +
        `共捕获 ${String(rolledBack.bodies.length)} 条 / 折叠点系统事件 ${String(rolledBack.markerEvents)} 条 / ` +
        `末条任务请求 ${String(rolledBackLast.length)} 字符）\n` +
        // 2026-10-11 加：把"折叠点相对切点/回滚的位置"与回合数一并打出。该判据的偶发红有两种
        // 完全不同的成因（① 回滚没截断 ② 回滚后重新折叠了一次），旧消息只有总数分不出二者。
        `      定位读数：事件 ${String(rolledBack.eventTypes.length)} 条 / 折叠点位置 ` +
        `[${rolledBack.markerIndexes.join(',')}] / 检查点位置 ${String(rolledBack.checkpointIndex)} / ` +
        `切点后折叠点 ${String(rolledBack.markersAfterCheckpoint)} / 回滚位置 ${String(rolledBack.rewindIndex)}` +
        `（-1 ＝ 已被截掉，说明截断确实发生）\n` +
        `      命中处：${excerpt}\n` +
        `      实验组全部捕获体（判断是"仪器漏标记"还是"产品真泄漏"）：\n${classify(rolledBack.bodies)}`,
    );
  }

  // **旁证**：回滚截断了日志 ⇒ 折叠点系统事件不再存在，且日志明显更短。
  assert.strictEqual(rolledBack.markerEvents, 0, '回滚后日志里仍留着折叠点系统事件 ⇒ 截断没生效');
  assert.ok(
    rolledBack.eventTypes.length < control.eventTypes.length,
    `回滚后的日志应明显更短（实验 ${String(rolledBack.eventTypes.length)} vs 控制 ${String(control.eventTypes.length)}）`,
  );

  // **反真空**：两遍都真的跑过多步。
  assert.ok(control.bodies.length >= 5 && rolledBack.bodies.length >= 5, '请求样本过少');
});

test('单元级回归守卫：回滚截断日志后不残留旧摘要（压缩器安全重折）', async () => {
  /** 可变事件日志（模拟 `recorder.rewindTo` 的截断）。 */
  let events: Record<string, unknown>[] = [];
  const recorder = {
    allEvents: () => events,
    system: (content: string) => {
      events.push({ type: 'system', payload: { content }, sessionId: 's' });
    },
  };
  const summarizer = new CapturingModel(new ScriptedModel([], '收尾'));
  const compactor = new ContextCompactor(summarizer, { maxTokens: 40, keepRecent: 1 });
  const builder = new StepContextBuilder({
    model: summarizer,
    tools: {},
    approvals: {},
    sandbox: {},
    sessionId: 's',
    recorder,
    workspaceRoot: '/ws',
    repoMapEnabled: false,
    repoMapContext: {},
    fragments: [],
    compactor,
  } as never);
  // 长历史：确保首次组装就触发压缩并写入 `OMNI_COMPACTION_V1` 游标事件。
  events = Array.from({ length: 6 }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    payload: { content: `${'长'.repeat(120)} 第 ${String(i)} 条` },
    sessionId: 's',
  }));

  const first = JSON.stringify(await builder.buildMessages());
  assert.ok(first.includes(`${SUMMARY_SENTINEL}_v1`), '首次组装应发生压缩并出现 v1 摘要哨兵');
  assert.ok(
    events.some((e) =>
      String((e.payload as { content?: unknown }).content ?? '').startsWith(COMPACTION_MARKER),
    ),
    '压缩后应把游标事件写回日志（否则后续无从恢复）',
  );

  // 模拟 `checkpoint` 回滚：日志被截断到"游标事件之前"。
  events = events.slice(0, 2);
  const before = summarizer.summaries;

  // 截断后无论是否显式对齐，都**不得**把已截断的旧摘要原样带出来。
  const stale = JSON.stringify(await builder.buildMessages());
  assert.ok(summarizer.summaries > before, '截断后压缩器应重新折叠（而不是复用已被截断的折叠点）');
  assert.ok(
    !stale.includes(`${SUMMARY_SENTINEL}_v1`),
    '重新折叠后，被截断的旧摘要（v1）不得再出现在消息里',
  );

  builder.rewindCompactionState();
  const realigned = JSON.stringify(await builder.buildMessages());
  assert.ok(
    !realigned.includes(`${SUMMARY_SENTINEL}_v1`),
    '显式对齐游标后同样不得出现被截断的旧摘要（v1）',
  );
});
