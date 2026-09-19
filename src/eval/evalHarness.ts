// 评估/基准 harness（C3 — 填补 P2-2「评估/benchmark harness 缺失」缺口）。
//
// 定位：把一次性基准（tests/bench/agentTask.bench.ts 的 ScriptedModel 范式）泛化为可复用、
// 可回归的质量回归基准。一条 EvalTask = 一段模型脚本 + 期望断言；runEvalSuite 经真实 Agent
//（+ createRuntime + 内存存储 + 自动审批 + passthrough 沙箱）跑完所有任务，收集工具调用、
// 步数、耗时，并按期望断言给出 pass/fail。纯 TS、确定性、零外部依赖，可纳入 CI。
//
// 铁律：零运行时依赖（仅 node: 内置）；fail-closed——断言缺失即视为「未验证」，不假通过。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Agent } from '../core/agent.js';
import type { AgentResult } from '../core/agent.js';
import { createRuntime } from '../core/runtime.js';
import { ConfigFactory } from '../config/configFactory.js';
import { MemoryStorage } from '../adapters/storage/memoryStorage.js';
import { AutoApproval } from '../adapters/approval/autoApproval.js';
import { SilentEventPort } from '../adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../adapters/sandbox/passthroughSandbox.js';
import type { ModelPort } from '../ports/model/model.js';
import type { SupervisorPort, SafeMode, HealthSnapshot } from '../ports/runtime/supervisor.js';
import { WorkspaceFileWalker } from '../util/workspaceFileWalker.js';
import { ScriptedModel, type ScriptStep } from './scriptedModel.js';
import { IsolatedEvaluator } from './isolatedEvaluator.js';
import type { ReasoningEffort } from './reasoningRouter.js';

export type { ScriptStep } from './scriptedModel.js';

/**
 * 评估用 no-op 监督内核：eval 场景下纯测 agent 能力，剥离生产级 SupervisorKernel 的
 * 安全降级噪声（首个危险工具失败即翻 safe 模式、永久拦截 write_file/apply_patch/shell，
 * 使「写文件」类任务无法完成、指标失真）。report/intercept 均放行，模式恒为 nominal。
 */
class NoopSupervisor implements SupervisorPort {
  /** no-op：eval 不追踪工具健康，上报即忽略。
   * @returns 无返回值。
   */
  public report(): void {}
  /** 恒返回 nominal：eval 剥离生产级安全降级，模式不变。 */
  public mode(): SafeMode {
    return 'nominal';
  }
  /** 恒返回 nominal + 空健康向量的快照（仅满足端口形状，generatedAt 取当前时间）。 */
  public snapshot(): HealthSnapshot {
    return { mode: 'nominal', entries: [], generatedAt: new Date().toISOString() };
  }
  /** 恒放行：返回 undefined，不拦截任何工具调用。 */
  public intercept(): string | undefined {
    return undefined;
  }
  /** no-op：eval 无模式转移，订阅回调被直接丢弃。
   * @returns 无返回值。
   */
  public onTransition(): void {}
  /** 恒返回 nominal：无降级发生，无需恢复。 */
  public attemptRecovery(): SafeMode {
    return 'nominal';
  }
  /**
   * extractUsage — module-level helper moved into NoopSupervisor.
   * @param {readonly { type: string; payload: unknown }[]} events - events
   * @returns {TaskUsage | undefined} - result
   */
  public static extractUsage(
    events: readonly { type: string; payload: unknown }[],
  ): TaskUsage | undefined {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let found = false;
    for (const ev of events) {
      const u = (
        ev.payload as
          | {
              usage?: Partial<TaskUsage>;
            }
          | undefined
      )?.usage;
      if (u !== undefined && typeof u === 'object') {
        if (typeof u.promptTokens === 'number') {
          promptTokens += u.promptTokens;
          found = true;
        }
        if (typeof u.completionTokens === 'number') completionTokens += u.completionTokens;
        if (typeof u.totalTokens === 'number') totalTokens += u.totalTokens;
      }
    }
    return found
      ? {
          promptTokens,
          completionTokens,
          totalTokens: totalTokens || promptTokens + completionTokens,
        }
      : undefined;
  }
  /**
   * extractToolCalls — module-level helper moved into NoopSupervisor.
   * @param {readonly { type: string; payload: unknown }[]} events - events
   * @returns {string[]} - result
   */
  public static extractToolCalls(events: readonly { type: string; payload: unknown }[]): string[] {
    const names: string[] = [];
    for (const ev of events) {
      if (ev.type !== 'tool_call') continue;
      const p = ev.payload as {
        name?: unknown;
      };
      if (typeof p.name === 'string' && p.name.length > 0) names.push(p.name);
    }
    return names;
  }
}

/**
 * @beta
 * 单任务的期望断言。
 */
export interface EvalExpectation {
  /** 期望出现过的工具名（子集，忽略顺序）；缺省不校验工具。 */
  readonly tools?: readonly string[];
  /** 期望最终文本包含的子串；缺省不校验文本。 */
  readonly text?: string;
  /** 期望工作区内写出的文件：路径 → 内容应包含的子串；缺省不校验文件。 */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * 真实可验证门禁（U5 强化）：在工作区执行一条命令，要求退出码等于 `expectExit`（默认 0）。
   * 用于「让测试真正变绿」类任务——子串校验只验结构，shell 校验验行为。fail-closed：命令
   * 缺失/抛错/非零退出均判 fail。
   */
  readonly run?: { readonly cmd: string; readonly expectExit?: number };
  /** 软上限：实际步数超过则记一条 reason（不强制 fail，便于观察）。 */
  readonly maxSteps?: number;
}

/**
 * @beta
 * 单条评估任务（声明式）。
 */
export interface EvalTask {
  /** 唯一 id（报告与退出码依据）。 */
  readonly id: string;
  /** 任务说明（人类可读）。 */
  readonly description?: string;
  /** 喂给 agent.runTask 的用户 prompt。 */
  readonly prompt: string;
  /** 模型脚本（按顺序 replay）。live 跑分注入真实模型时可为空。 */
  readonly script?: readonly ScriptStep[];
  /** 脚本耗尽后的兜底终态文本（缺省 '任务完成（eval）'）。 */
  readonly finalText?: string;
  /** 单任务步数上限（缺省 16）。 */
  readonly maxSteps?: number;
  /** 预置到工作区的文件：路径 → 内容（相对工作区根）。 */
  readonly seedFiles?: Readonly<Record<string, string>>;
  /** 期望断言。 */
  readonly expect?: EvalExpectation;
}

/**
 * @beta
 * 评估套件。
 */
export interface EvalSuite {
  /** 套件名（报告标题）。 */
  readonly name: string;
  /** 套件说明。 */
  readonly description?: string;
  /** 任务列表。 */
  readonly tasks: readonly EvalTask[];
}

/** 模型用量（从事件流聚合，live 跑分时给出真实 token 成本）。 */
export interface TaskUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * @beta
 * 单任务结果。
 */
export interface EvalTaskResult {
  readonly id: string;
  readonly passed: boolean;
  readonly steps: number;
  readonly toolCalls: readonly string[];
  readonly durationMs: number;
  readonly reasons: readonly string[];
  readonly finalText?: string | undefined;
  /** 模型用量（live 跑分时有值；ScriptedModel 无用量则为 undefined）。 */
  readonly usage?: TaskUsage | undefined;
  /** 隔离评测证据（仅 {@link runTaskIsolated} 填充：评测只吃冻结快照）。 */
  readonly isolation?: IsolationEvidence | undefined;
}

/**
 * 生成阶段产物快照（T4.6）：**评测唯一可见的输入**。
 *
 * 生成阶段（真实 Agent 跑任务）结束时采集一次，之后深克隆 + 深冻结；评测不再读工作区活引用。
 */
export interface TaskArtifact {
  /** 生成阶段实际调用的工具名（事件流投影）。 */
  readonly toolCalls: readonly string[];
  /** 生成阶段步数。 */
  readonly steps: number;
  /** 生成阶段终态文本。 */
  readonly finalText: string | undefined;
  /** 工作区相对路径 → 内容（采集时的产物，与后续写操作零共享）。 */
  readonly files: Readonly<Record<string, string>>;
}

/** 隔离评测证据（写进结果，供脚本/报告断言「评测确实只吃快照」）。 */
export interface IsolationEvidence {
  /** 是否为冻结快照评测（走隔离路径恒 true）。 */
  readonly frozen: boolean;
  /** 快照内文件数（0 表示产物无文件，例如纯文本任务）。 */
  readonly snapshotFiles: number;
  /** 隔离评测器返回的 verdict（0..1；与 passed 同源）。 */
  readonly verdict: number;
}

/** 隔离跑分选项（T5.5 推理强度路由的接线口）。 */
export interface IsolatedRunOptions {
  /**
   * 推理强度：由 `ReasoningRouter` 按任务难度路由后注入，经 `ConfigFactory.build` 落到
   * `ResolvedConfig.reasoning`，再由 StepRunner 透传为模型请求的 `reasoning_effort`。
   * 缺省 undefined → 不发该字段（按后端默认），零行为变更。
   */
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

/**
 * @beta
 * 套件汇总报告。
 */
export interface EvalReport {
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly results: readonly EvalTaskResult[];
  readonly totalDurationMs: number;
}

/** 从事件流提取被实际执行的工具名（tool_call 事件 payload.name）。 */

/**
 * 从事件流聚合模型用量（防御式扫描 payload 中的 usage 字段）。
 * 任意事件携带 { usage: { promptTokens, completionTokens, totalTokens } } 即累加，
 * 找不到则保持 undefined（如 ScriptedModel 确定性回归）。
 */

/**
 * @beta
 * 纯函数评分：依据期望断言对一次任务结果打分（不依赖 Agent，便于单测）。
 * 任一期望不满足即 fail-closed（记 reason），不假通过。
 */
export function scoreTask(params: {
  readonly toolCalls: readonly string[];
  readonly finalText: string | undefined;
  readonly expectation: EvalExpectation;
  readonly steps: number;
  readonly workspaceRoot: string;
}): { readonly passed: boolean; readonly reasons: readonly string[] } {
  const { toolCalls, finalText, expectation, steps, workspaceRoot } = params;
  const reasons: string[] = [];

  if (expectation.tools !== undefined) {
    for (const expected of expectation.tools) {
      if (!toolCalls.includes(expected)) {
        reasons.push(`缺少期望工具调用: ${expected}（实际: [${toolCalls.join(', ')}]）`);
      }
    }
  }
  if (expectation.text !== undefined) {
    if (finalText === undefined || !finalText.includes(expectation.text)) {
      reasons.push(`最终文本不含期望子串: ${expectation.text}`);
    }
  }
  if (expectation.files !== undefined) {
    for (const [rel, sub] of Object.entries(expectation.files)) {
      const fp = join(workspaceRoot, rel);
      if (!existsSync(fp)) {
        reasons.push(`期望文件不存在: ${rel}`);
        continue;
      }
      const content = readFileSync(fp, 'utf8');
      if (!content.includes(sub)) {
        reasons.push(`文件 ${rel} 内容不含期望子串: ${sub}`);
      }
    }
  }
  if (expectation.run !== undefined) {
    const want = expectation.run.expectExit ?? 0;
    let status = -1;
    let stderr = '';
    try {
      const r = spawnSync(expectation.run.cmd, [], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        shell: true,
        timeout: 60_000,
      });
      status = r.status ?? -1;
      stderr = typeof r.stderr === 'string' ? r.stderr : '';
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err);
    }
    if (status !== want) {
      reasons.push(
        `验证命令「${expectation.run.cmd}」退出码 ${status} ≠ 期望 ${want}` +
          (stderr ? `: ${stderr.slice(0, 200)}` : ''),
      );
    }
  }
  if (expectation.maxSteps !== undefined && steps > expectation.maxSteps) {
    reasons.push(`步数 ${steps} 超过期望上限 ${expectation.maxSteps}`);
  }

  return { passed: reasons.length === 0, reasons };
}

/** 快照单文件上限（超过则不入快照：评测产物应是可评审的文本，不是大二进制）。 */
const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;

/** 预置任务自带的种子文件到工作区（套件自包含，read_file 等不必依赖外部资源）。 */
function seedTaskWorkspace(task: EvalTask, workspaceRoot: string): void {
  for (const [rel, content] of Object.entries(task.seedFiles ?? {})) {
    const fp = join(workspaceRoot, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content, 'utf8');
  }
}

/** 解析本任务的模型端口：注入的真实模型优先，否则确定性 ScriptedModel（CI / 离线回归）。 */
function resolveTaskModel(task: EvalTask, model: ModelPort | undefined): ModelPort {
  return model ?? new ScriptedModel(task.script ?? [], task.finalText ?? '任务完成（eval）');
}

/**
 * 采集生成阶段产物快照（投影：工作区文本文件 + 事件流统计）。
 * 采集期读取失败的文件（并发写入等）跳过——快照只记录可稳定读取的产物。
 * @param result 生成阶段结果（AgentResult）
 * @param workspaceRoot 工作区根
 * @returns 产物快照
 */
async function collectTaskArtifact(
  result: AgentResult,
  workspaceRoot: string,
): Promise<TaskArtifact> {
  const walker = new WorkspaceFileWalker(workspaceRoot, { maxFiles: 2000 });
  const { files: rels } = await walker.list();
  const files: Record<string, string> = {};
  for (const rel of rels) {
    const fp = join(workspaceRoot, ...rel.split('/'));
    try {
      if (statSync(fp).size > MAX_SNAPSHOT_FILE_BYTES) continue;
      files[rel] = readFileSync(fp, 'utf8');
    } catch {
      // 采集期文件已消失 → 跳过（不会进入评测快照）
    }
  }
  return {
    toolCalls: NoopSupervisor.extractToolCalls(result.events),
    steps: result.steps,
    finalText: result.finalText,
    files,
  };
}

/**
 * 生成阶段（T4.6 隔离的一半）：预置文件 → 装配真实 Agent → 执行任务 → 采集产物快照。
 * 本函数**不做任何评测**：评测由调用方在快照上完成。
 * @param task 评估任务
 * @param workspaceRoot 工作区根
 * @param model 模型端口（缺省 ScriptedModel）
 * @param reasoningEffort 推理强度（缺省不发该字段）
 * @returns 生成结果与产物快照
 */
async function generateTaskArtifact(
  task: EvalTask,
  workspaceRoot: string,
  model: ModelPort | undefined,
  reasoningEffort: ReasoningEffort | undefined,
): Promise<{ readonly result: AgentResult; readonly artifact: TaskArtifact }> {
  seedTaskWorkspace(task, workspaceRoot);
  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: task.maxSteps ?? 16,
    model: resolveTaskModel(task, model),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...(reasoningEffort !== undefined ? { reasoning: reasoningEffort } : {}),
  });
  const agent = new Agent(createRuntime({ ...config, supervisor: new NoopSupervisor() }));
  const result = await agent.runTask(task.prompt);
  return { result, artifact: await collectTaskArtifact(result, workspaceRoot) };
}

/** 把冻结快照物化到 scratch 目录（评测命令只在该副本上执行，绝不碰生成方工作区）。 */
function materializeSnapshot(snapshot: Readonly<TaskArtifact>, root: string): number {
  let written = 0;
  for (const [rel, content] of Object.entries(snapshot.files)) {
    const fp = join(root, ...rel.split('/'));
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content, 'utf8');
    written += 1;
  }
  return written;
}

/**
 * 在冻结快照上评分（T4.6 隔离的另一半）：快照物化到临时 scratch 后跑全部断言，
 * 故评测结论只依赖快照内容——生成方此后对工作区的任何修改都进不了本次 verdict。
 * @param task 评估任务
 * @param snapshot 冻结快照
 * @returns 通过与否 + 失败原因
 */
function scoreFrozenSnapshot(
  task: EvalTask,
  snapshot: Readonly<TaskArtifact>,
): { readonly passed: boolean; readonly reasons: readonly string[] } {
  const scratch = mkdtempSync(join(tmpdir(), 'omni-eval-snapshot-'));
  try {
    materializeSnapshot(snapshot, scratch);
    return scoreTask({
      toolCalls: snapshot.toolCalls,
      finalText: snapshot.finalText,
      expectation: task.expect ?? {},
      steps: snapshot.steps,
      workspaceRoot: scratch,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** 跑单条任务：预置文件 → 装配模型（注入真实模型或默认 ScriptedModel）+ 真实 Agent → 执行 → 评分。 */
export async function runTask(
  task: EvalTask,
  workspaceRoot: string,
  model?: ModelPort,
): Promise<EvalTaskResult> {
  const t0 = Date.now();
  const { result, artifact } = await generateTaskArtifact(task, workspaceRoot, model, undefined);
  const durationMs = Date.now() - t0;
  const { passed, reasons } = scoreTask({
    toolCalls: artifact.toolCalls,
    finalText: artifact.finalText,
    expectation: task.expect ?? {},
    steps: artifact.steps,
    workspaceRoot,
  });

  return {
    id: task.id,
    passed,
    steps: artifact.steps,
    toolCalls: artifact.toolCalls,
    durationMs,
    reasons,
    finalText: artifact.finalText,
    usage: NoopSupervisor.extractUsage(result.events),
  };
}

/**
 * 跑单条任务（**隔离评测版**，T4.6 · H6）：生成 → 深克隆冻结快照 → **评测只吃快照**。
 *
 * 与 {@link runTask} 的差别只在评测侧：`runTask` 的断言直接读生成方工作区（自评偏差通道），
 * 本函数把产物采集为快照交给 `IsolatedEvaluator`（结构化克隆 + 逐层冻结），断言与验证命令
 * 都只在快照副本上执行。生成方后续任何写操作都不可能改变本次 verdict。
 *
 * @param task 评估任务
 * @param workspaceRoot 工作区根（生成阶段用；评测阶段只用其快照副本）
 * @param model 模型端口（缺省 ScriptedModel）
 * @param opts 推理强度等（缺省零行为变更）
 * @returns 任务结果（含 {@link IsolationEvidence}）
 */
export async function runTaskIsolated(
  task: EvalTask,
  workspaceRoot: string,
  model?: ModelPort,
  opts: IsolatedRunOptions = {},
): Promise<EvalTaskResult> {
  const t0 = Date.now();
  const { result, artifact } = await generateTaskArtifact(
    task,
    workspaceRoot,
    model,
    opts.reasoningEffort,
  );
  const durationMs = Date.now() - t0;
  let passed = false;
  let reasons: readonly string[] = ['隔离评测未执行（生成阶段未产出可评测快照）'];
  const evaluator = IsolatedEvaluator.projected<TaskArtifact, TaskArtifact>({
    generate: () => artifact,
    project: (a) => a,
    evaluate: (snapshot) => {
      const scored = scoreFrozenSnapshot(task, snapshot);
      passed = scored.passed;
      reasons = scored.reasons;
      return scored.passed ? 1 : 0;
    },
  });
  const verdict = await evaluator.run();

  return {
    id: task.id,
    passed,
    steps: artifact.steps,
    toolCalls: artifact.toolCalls,
    durationMs,
    reasons,
    finalText: artifact.finalText,
    usage: NoopSupervisor.extractUsage(result.events),
    isolation: {
      frozen: Object.isFrozen(verdict.snapshot),
      snapshotFiles: Object.keys(verdict.snapshot.files).length,
      verdict: verdict.verdict,
    },
  };
}

/** 跑整套件：逐任务执行并聚合报告。未提供 workspaceRoot 时自建临时目录并在末尾清理。 */
export async function runEvalSuite(
  suite: EvalSuite,
  opts?: { readonly workspaceRoot?: string },
): Promise<EvalReport> {
  const ownWorkspace = opts?.workspaceRoot === undefined;
  const workspaceRoot = opts?.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'omni-eval-'));
  const results: EvalTaskResult[] = [];
  const t0 = Date.now();
  try {
    for (const task of suite.tasks) {
      results.push(await runTask(task, workspaceRoot));
    }
  } finally {
    if (ownWorkspace) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
  const totalDurationMs = Date.now() - t0;
  const passed = results.filter((r) => r.passed).length;
  return {
    suite: suite.name,
    passed,
    failed: results.length - passed,
    total: results.length,
    results,
    totalDurationMs,
  };
}

/**
 * @beta
 * 人类可读报告。
 */
export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`=== Eval 套件: ${report.suite} ===`);
  if (report.results.length === 0) {
    lines.push('（无任务）');
  }
  for (const r of report.results) {
    const mark = r.passed ? '✅' : '❌';
    const usageStr = r.usage
      ? `  tokens=${r.usage.totalTokens}(in:${r.usage.promptTokens}/out:${r.usage.completionTokens})`
      : '';
    lines.push(
      `${mark} ${r.id}  steps=${r.steps}  tools=[${r.toolCalls.join(', ')}]  ${r.durationMs}ms${usageStr}`,
    );
    if (!r.passed) {
      for (const reason of r.reasons) lines.push(`     - ${reason}`);
    }
  }
  lines.push(
    `--- 汇总: ${report.passed}/${report.total} 通过, 失败 ${report.failed}, 总耗时 ${report.totalDurationMs}ms ---`,
  );
  return lines.join('\n');
}

/**
 * @beta
 * 从 JSON 文件加载套件（最小形状校验：须含 tasks 数组）。
 */
export function loadSuiteFromJson(path: string): EvalSuite {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const obj = raw as Record<string, unknown>;
  if (typeof obj !== 'object' || obj === null || !Array.isArray(obj.tasks)) {
    throw new Error(`eval suite 格式错误（缺少 tasks 数组）: ${path}`);
  }
  return raw as EvalSuite;
}
