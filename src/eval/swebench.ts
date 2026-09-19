// SWE-bench 风格能力评估 harness（自包含、可离线、零依赖）。
//
// 定位：把"编码能力"变成可机械验证的指标，直接回应报告 #20 的 P3 诚实缺口
// （"OmniHarness 尚未跑 SWE-bench，能力分数维度暂无 apples-to-apples 对照"）。
//
// 一条 SweTask = 一个自包含 bug 修复任务：
//   - seedFiles：预置到工作区的"带 bug 代码 + 失败测试"；
//   - prompt：要求 agent 修复 bug；
//   - evalCmd：在工作区内执行的测试命令（退出码 0 = 通过，即 SWE-bench 的 FAIL_TO_PASS）。
//
// 两种运行模式（同一套件，可复现）：
//   - 'scripted'（确定性基建模式）：用 ScriptedModel 按脚本 replay 修复步骤，
//     证明「读文件 → 应用补丁 → 跑测试 → 评分」真实链路可用（零 API Key）。
//   - 'live'（真实 LLM 模式）：用 OpenAiCompatibleModel + BudgetedModel 护栏，
//     跑真实底座模型的能力分数（需 DEEPSEEK_API_KEY，见 benchmark/capability_swebench.mjs）。
//
// 科学卫生（fail-closed）：
//   - 阳性对照 runGoldControl：直接套用 goldPatch，评分器必须判过（证明评分器不假阴）；
//   - 阴性对照 runNegativeControl：仅 seed 不修复，评分器必须判不过（证明不假阳）。
//   二者任一失效即说明任务定义或评分器有误，整套能力分数作废。
//
// 铁律：零运行时依赖（仅 node: 内置）；fail-closed——评分只认 evalCmd 退出码，绝不臆造通过。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Agent } from '../core/agent.js';
import type { AgentResult } from '../core/agent.js';
import { createRuntime } from '../core/runtime.js';
import { ToolGate } from '../core/toolGate.js';
import { ConfigFactory } from '../config/configFactory.js';
import { MemoryStorage } from '../adapters/storage/memoryStorage.js';
import { AutoApproval } from '../adapters/approval/autoApproval.js';
import { SilentEventPort } from '../adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../adapters/sandbox/passthroughSandbox.js';
import { PatchApplier } from '../adapters/tool/fs/patchApplier.js';
import { WorkspaceFileWalker } from '../util/workspaceFileWalker.js';
import type { ModelPort } from '../ports/model/model.js';
import type { ScriptStep } from './scriptedModel.js';
import { EditDriftDetector } from './editDriftDetector.js';
import type { DriftAlarm } from './editDriftDetector.js';
import type { ReasoningEffort } from './reasoningRouter.js';

/**
 * Swebench 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class Swebench {
  /**
   * C7 收口：原顶层内部函数迁入宿主类。
   * @param task SweTask
   * @param workspaceRoot string
   * @returns void
   */
  public static seedWorkspace(task: SweTask, workspaceRoot: string): void {
    for (const [rel, content] of Object.entries(task.seedFiles)) {
      const fp = join(workspaceRoot, rel);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content, 'utf8');
    }
  }

  /**
   * 采集工作区文件指纹快照（反漂移检测的「补丁应用前 / 后」两端）。
   * @param workspaceRoot 工作区根（绝对路径）
   * @returns 相对 POSIX 路径 → 内容 sha1 指纹
   */
  public static async snapshotFiles(workspaceRoot: string): Promise<Map<string, string>> {
    const walker = new WorkspaceFileWalker(workspaceRoot, { maxFiles: 5000 });
    const { files } = await walker.list();
    const snapshot = new Map<string, string>();
    for (const rel of files) {
      try {
        snapshot.set(rel, Swebench.revision(readFileSync(join(workspaceRoot, rel), 'utf8')));
      } catch {
        // 采集期文件消失（并发写）→ 跳过：该文件本端指纹缺失，下端会被记为一次编辑
      }
    }
    return snapshot;
  }

  /**
   * 把「前后两次快照的差异」喂给反漂移检测器（内容不变视为未编辑，由检测器兜底）。
   * @param detector 编辑漂移检测器（缺省 undefined = 不做检测，零行为变更）
   * @param before 补丁应用前快照
   * @param after 补丁应用后快照
   * @returns 命中的漂移告警（无检测器时为空）
   */
  public static recordDrift(
    detector: EditDriftDetector | undefined,
    before: ReadonlyMap<string, string>,
    after: ReadonlyMap<string, string>,
  ): DriftAlarm[] {
    if (detector === undefined) return [];
    const alarms: DriftAlarm[] = [];
    for (const [file, revision] of after) {
      if (before.get(file) === revision) continue;
      const alarm = detector.record({ file, revision });
      if (alarm !== undefined) alarms.push(alarm);
    }
    return alarms;
  }

  /**
   * 内容指纹（sha1 十六进制；仅作「是否同一版本」判据，非安全用途）。
   * @param content 文件内容
   * @returns 40 位十六进制指纹
   */
  private static revision(content: string): string {
    return createHash('sha1').update(content, 'utf8').digest('hex');
  }

  /**
   * 异常路径的漂移采集：agent 抛错时仍把「改到一半」的编辑计入反漂移流
   * （丢预算前兆往往正是「改了一半就崩」，不能因异常而漏掉信号）。
   * @param workspaceRoot 工作区根
   * @param detector 检测器（undefined = 不检测）
   * @param before 动手前快照
   * @returns 可展开进结果的漂移字段（无告警时为空对象）
   */
  public static async driftResult(
    workspaceRoot: string,
    detector: EditDriftDetector | undefined,
    before: ReadonlyMap<string, string>,
  ): Promise<{ readonly driftAlarms?: readonly DriftAlarm[] | undefined }> {
    if (detector === undefined) return {};
    const after = await Swebench.snapshotFiles(workspaceRoot);
    const driftAlarms = Swebench.recordDrift(detector, before, after);
    return driftAlarms.length > 0 ? { driftAlarms } : {};
  }
}

/**
 * @beta
 * 单条 SWE 风格 bug 修复任务（声明式、自包含）。
 */
export interface SweTask {
  /** 唯一 id（报告依据）。 */
  readonly id: string;
  /** 任务说明（人类可读）。 */
  readonly description?: string;
  /** 喂给 agent.runTask 的修复指令。 */
  readonly prompt: string;
  /** 预置到工作区的文件：路径 → 内容（相对工作区根）。须含可失败测试 + 带 bug 源码。 */
  readonly seedFiles: Readonly<Record<string, string>>;
  /** 在工作区内执行的测试命令；退出码 0 视为修复成功（FAIL_TO_PASS）。 */
  readonly evalCmd: string;
  /** 确定性基建模式：ScriptedModel replay 的修复步骤（缺省不跑 scripted）。 */
  readonly script?: readonly ScriptStep[];
  /** 脚本耗尽后的兜底终态文本（缺省 '任务完成（swebench）'）。 */
  readonly finalText?: string;
  /** 单任务步数上限（缺省 16）。 */
  readonly maxSteps?: number;
  /** 阳性对照补丁（unified diff）；runGoldControl 直接套用，应当通过。 */
  readonly goldPatch?: string;
}

/**
 * @beta
 * 单任务结果。
 */
export interface SweTaskResult {
  readonly id: string;
  /** evalCmd 退出码是否为 0。 */
  readonly passed: boolean;
  /** evalCmd 实测退出码。 */
  readonly evalExitCode: number;
  /** 运行模式。 */
  readonly mode: 'scripted' | 'live' | 'control';
  /** agent 实际步数（control 模式为 0）。 */
  readonly steps: number;
  /** 未通过原因（passed 时缺省）。 */
  readonly reason?: string | undefined;
  /**
   * 本轮「补丁应用前后」的编辑漂移告警（T4.2）：
   * 注入 `EditDriftDetector` 时才采集；无告警为 undefined（零输出噪声）。
   */
  readonly driftAlarms?: readonly DriftAlarm[] | undefined;
}

/**
 * @beta
 * 套件汇总报告。
 */
export interface SweReport {
  readonly suite: string;
  readonly mode: 'scripted' | 'live';
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly results: readonly SweTaskResult[];
  readonly totalDurationMs: number;
}

/**
 * @beta
 * 阳性/阴性对照报告。
 */
export interface SweControlReport {
  /** 阳性对照（直接套 goldPatch，必须全过）。 */
  readonly gold: readonly SweTaskResult[];
  /** 阴性对照（仅 seed 不修复，必须全不过）。 */
  readonly negative: readonly SweTaskResult[];
  /** 对照全部有效（gold 全过 且 negative 全不过）。 */
  readonly valid: boolean;
}

// ---------- 纯函数评分（便于单测，不依赖 Agent）----------

/** 在给定 cwd 执行命令，返回退出码（异常/非 0 均如实返回状态码）。 */
export function runEval(cmd: string, cwd: string): number {
  try {
    execFileSync(cmd, { cwd, shell: true, stdio: 'pipe' });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

/** 退出码 0 = 通过（SWE-bench FAIL_TO_PASS 判定）。 */
export function scoreSweResult(exitCode: number): boolean {
  return exitCode === 0;
}

// ---------- 模式一：确定性基建（ScriptedModel replay）----------

/**
 * @beta
 * 跑单条任务：预置文件 → 真实 Agent（给定 model）→ 执行 → 跑 evalCmd 评分。
 * model 由调用方构造（scripted 或 live），本函数不耦合具体模型实现。
 *
 * `opts.driftDetector` 注入时，在 agent 动手前 / 收工后各取一次工作区指纹快照，把差异喂给
 * 反漂移检测器（同一文件反复改的 oscillation / thrash 会被记进结果的 `driftAlarms`）。
 * 检测器状态**按工作区重置**：每个任务跑在独立临时工作区，跨工作区沿用同一份指纹历史会把
 * 「不同任务恰好同名文件」误判为振荡（实测：gold 对照会刷出成片假告警）。
 *
 * @param task 任务定义
 * @param workspaceRoot 工作区根
 * @param model 模型端口
 * @param mode 运行模式（scripted / live）
 * @param opts 反漂移检测器与推理强度（缺省均不生效，零行为变更）
 * @returns 单任务结果（含漂移告警）
 */
export async function runSweTask(
  task: SweTask,
  workspaceRoot: string,
  model: ModelPort,
  mode: 'scripted' | 'live',
  opts: {
    readonly driftDetector?: EditDriftDetector | undefined;
    readonly reasoningEffort?: ReasoningEffort | undefined;
  } = {},
): Promise<SweTaskResult> {
  opts.driftDetector?.reset();
  Swebench.seedWorkspace(task, workspaceRoot);
  const before = await Swebench.snapshotFiles(workspaceRoot);

  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: task.maxSteps ?? 16,
    model,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...(opts.reasoningEffort !== undefined ? { reasoning: opts.reasoningEffort } : {}),
  });
  const runtime = createRuntime(config);
  // 能力评估是受控沙箱测量：解耦生产级安全监督内核（#P3）。
  // 否则单次 apply_patch 失败即被监督内核推进 safe 模式、永久拦截写类工具，阻断编码迭代；
  // 评估只测模型编码能力，不测安全 FDIR，故在此卸载监督内核并重建无监督门禁。
  (runtime as { supervisor?: unknown }).supervisor = undefined;
  (runtime as { gate: ToolGate }).gate = new ToolGate(
    config.approvals,
    config.sandbox,
    config.plan,
    config.planMode,
    config.escalation,
    config.elevatedSandbox,
    undefined,
  );
  const agent = new Agent(runtime);

  let result: AgentResult;
  try {
    result = await agent.runTask(task.prompt);
  } catch (err) {
    // 单任务运行异常（如模型请求失败）不应拖垮整套餐能评估：记失败原因，继续下一任务。
    const exit = runEval(task.evalCmd, workspaceRoot);
    return {
      id: task.id,
      passed: false,
      evalExitCode: exit,
      mode,
      steps: 0,
      reason: `agent 运行异常: ${String((err as { message?: string })?.message ?? err)}`,
      ...(await Swebench.driftResult(workspaceRoot, opts.driftDetector, before)),
    };
  }

  const after = await Swebench.snapshotFiles(workspaceRoot);
  const driftAlarms = Swebench.recordDrift(opts.driftDetector, before, after);
  const exit = runEval(task.evalCmd, workspaceRoot);
  const passed = scoreSweResult(exit);
  return {
    id: task.id,
    passed,
    evalExitCode: exit,
    mode,
    steps: result.steps,
    reason: passed ? undefined : `evalCmd 退出码 ${exit}（修复未达 FAIL_TO_PASS）`,
    ...(driftAlarms.length > 0 ? { driftAlarms } : {}),
  };
}

// ---------- 对照：阳性（goldPatch 必过）/ 阴性（不修复必不过）----------

/**
 * @beta
 * 阳性对照：直接套用 goldPatch（绕过 agent），评分器必须判过。证明评分器不假阴。
 *
 * `opts.driftDetector` 注入时，在 **goldPatch 应用前 / 后** 各取一次工作区指纹快照并喂给
 * 反漂移检测器——这是「补丁应用」这一步最直接的观测点（patch 反复回退/重写即告警）。
 * 检测器状态按工作区重置（同 {@link runSweTask}：跨工作区混用指纹历史会产生成片假振荡）。
 *
 * @param task 任务定义
 * @param workspaceRoot 工作区根
 * @param opts 反漂移检测器（缺省不检测，零行为变更）
 * @returns 对照结果（含漂移告警）
 */
export async function runGoldControl(
  task: SweTask,
  workspaceRoot: string,
  opts: { readonly driftDetector?: EditDriftDetector | undefined } = {},
): Promise<SweTaskResult> {
  opts.driftDetector?.reset();
  Swebench.seedWorkspace(task, workspaceRoot);
  const before = await Swebench.snapshotFiles(workspaceRoot);
  if (task.goldPatch !== undefined) {
    const applier = new PatchApplier();
    const parsed = applier.parse(task.goldPatch);
    if (!parsed.ok) {
      return {
        id: task.id,
        passed: false,
        evalExitCode: -1,
        mode: 'control',
        steps: 0,
        reason: `goldPatch 解析失败: ${parsed.error}`,
        ...(await Swebench.driftResult(workspaceRoot, opts.driftDetector, before)),
      };
    }
    const target = parsed.targetFile;
    const fp = join(workspaceRoot, target);
    if (!existsSync(fp)) {
      return {
        id: task.id,
        passed: false,
        evalExitCode: -1,
        mode: 'control',
        steps: 0,
        reason: `goldPatch 目标文件不存在: ${target}`,
        ...(await Swebench.driftResult(workspaceRoot, opts.driftDetector, before)),
      };
    }
    const original = readFileSync(fp, 'utf8');
    const applied = applier.apply(original, task.goldPatch);
    if (!applied.ok) {
      return {
        id: task.id,
        passed: false,
        evalExitCode: -1,
        mode: 'control',
        steps: 0,
        reason: `goldPatch 应用失败: ${applied.error}`,
        ...(await Swebench.driftResult(workspaceRoot, opts.driftDetector, before)),
      };
    }
    writeFileSync(fp, applied.newContent ?? '', 'utf8');
  }
  const after = await Swebench.snapshotFiles(workspaceRoot);
  const driftAlarms = Swebench.recordDrift(opts.driftDetector, before, after);
  const exit = runEval(task.evalCmd, workspaceRoot);
  const passed = scoreSweResult(exit);
  return {
    id: task.id,
    passed,
    evalExitCode: exit,
    mode: 'control',
    steps: 0,
    reason: passed ? undefined : `goldPatch 套用后仍 FAIL_TO_PASS 未过（任务定义或评分器有误）`,
    ...(driftAlarms.length > 0 ? { driftAlarms } : {}),
  };
}

/**
 * @beta
 * 阴性对照：仅 seed 不修复，评分器必须判不过。证明评分器不假阳。
 */
export async function runNegativeControl(
  task: SweTask,
  workspaceRoot: string,
): Promise<SweTaskResult> {
  Swebench.seedWorkspace(task, workspaceRoot);
  const exit = runEval(task.evalCmd, workspaceRoot);
  const passed = scoreSweResult(exit);
  return {
    id: task.id,
    passed,
    evalExitCode: exit,
    mode: 'control',
    steps: 0,
    reason: passed ? `阴性对照竟判过（bug 未使测试失败，任务定义有误）` : undefined,
  };
}

/**
 * @beta
 * 跑全部对照（阳性 + 阴性），返回有效性判定。未提供 workspaceRoot 时自建临时目录并清理。
 * @param tasks 任务集
 * @param opts 工作区根与反漂移检测器（缺省自建工作区、不检测）
 * @returns 对照报告（含有效性判定）
 */
export async function runControls(
  tasks: readonly SweTask[],
  opts?: {
    readonly workspaceRoot?: string;
    readonly driftDetector?: EditDriftDetector | undefined;
  },
): Promise<SweControlReport> {
  const own = opts?.workspaceRoot === undefined;
  const root = opts?.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'omni-swe-ctrl-'));
  const gold: SweTaskResult[] = [];
  const negative: SweTaskResult[] = [];
  try {
    for (const task of tasks) {
      const g = await runGoldControl(task, mkdtempSync(join(root, `g-${task.id}-`)), {
        ...(opts?.driftDetector !== undefined ? { driftDetector: opts.driftDetector } : {}),
      });
      gold.push(g);
      const n = await runNegativeControl(task, mkdtempSync(join(root, `n-${task.id}-`)));
      negative.push(n);
    }
  } finally {
    if (own) rmSync(root, { recursive: true, force: true });
  }
  const valid = gold.every((r) => r.passed) && negative.every((r) => !r.passed);
  return { gold, negative, valid };
}

// ---------- 套件运行 ----------

/**
 * @beta
 * 跑整套件（agent 模式）：逐任务在独立临时工作区执行并聚合报告。
 * 未提供 workspaceRoot 时自建临时目录并在末尾清理。
 *
 * @param suiteName 套件名（报告标题）
 * @param tasks 任务集
 * @param model 模型端口（`opts.modelFor` 存在时可传 null）
 * @param mode 运行模式（scripted / live）
 * @param opts 工作区根、按任务取模型、反漂移检测器、按任务路由推理强度
 * @returns 套件汇总报告
 */
export async function runSweSuite(
  suiteName: string,
  tasks: readonly SweTask[],
  model: ModelPort | null,
  mode: 'scripted' | 'live',
  opts?: {
    readonly workspaceRoot?: string;
    readonly modelFor?: (task: SweTask) => ModelPort;
    /** 反漂移检测器（注入后逐任务记录「补丁应用前后」的编辑流）。 */
    readonly driftDetector?: EditDriftDetector | undefined;
    /** 按任务路由推理强度（`ReasoningRouter` 产物；透传为模型请求 reasoning_effort）。 */
    readonly reasoningFor?: ((task: SweTask) => ReasoningEffort | undefined) | undefined;
  },
): Promise<SweReport> {
  const own = opts?.workspaceRoot === undefined;
  const root = opts?.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'omni-swe-'));
  const results: SweTaskResult[] = [];
  const t0 = Date.now();
  try {
    for (const task of tasks) {
      const ws = mkdtempSync(join(root, `${task.id}-`));
      const m = opts?.modelFor !== undefined ? opts.modelFor(task) : (model as ModelPort);
      const effort = opts?.reasoningFor?.(task);
      results.push(
        await runSweTask(task, ws, m, mode, {
          ...(opts?.driftDetector !== undefined ? { driftDetector: opts.driftDetector } : {}),
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        }),
      );
    }
  } finally {
    if (own) rmSync(root, { recursive: true, force: true });
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    suite: suiteName,
    mode,
    passed,
    failed: results.length - passed,
    total: results.length,
    results,
    totalDurationMs: Date.now() - t0,
  };
}

/**
 * @beta
 * 人类可读报告（含对照有效性）。
 * @param report 套件报告
 * @param controls 对照报告（可选）
 * @returns 多行报告文本
 */
export function formatSweReport(report: SweReport, controls?: SweControlReport): string {
  const lines: string[] = [];
  lines.push(`=== SWE 能力套件: ${report.suite} (mode=${report.mode}) ===`);
  for (const r of report.results) {
    const mark = r.passed ? '✅' : '❌';
    lines.push(`${mark} ${r.id}  steps=${r.steps}  evalExit=${r.evalExitCode}`);
    if (!r.passed && r.reason !== undefined) lines.push(`     - ${r.reason}`);
    for (const alarm of r.driftAlarms ?? []) {
      lines.push(`     ⚠️ [反漂移·${alarm.kind}] ${alarm.file}: ${alarm.detail}`);
    }
  }
  lines.push(
    `--- 汇总: ${report.passed}/${report.total} 通过, 失败 ${report.failed}, 总耗时 ${report.totalDurationMs}ms ---`,
  );
  const alarmTotal = report.results.reduce((n, r) => n + (r.driftAlarms?.length ?? 0), 0);
  if (alarmTotal > 0) {
    lines.push(`--- 反漂移告警合计: ${alarmTotal} 条（同文件反复改的 oscillation / thrash）---`);
  }
  if (controls !== undefined) {
    lines.push(`=== 对照有效性: ${controls.valid ? '✅ 有效' : '❌ 失效'} ===`);
    for (const g of controls.gold) {
      lines.push(`  [阳性] ${g.id}: ${g.passed ? '✅ 过' : `❌ ${g.reason ?? ''}`}`);
      for (const alarm of g.driftAlarms ?? []) {
        lines.push(`     ⚠️ [反漂移·${alarm.kind}] ${alarm.file}: ${alarm.detail}`);
      }
    }
    for (const n of controls.negative) {
      lines.push(`  [阴性] ${n.id}: ${!n.passed ? '✅ 不过(正确)' : `❌ ${n.reason ?? ''}`}`);
    }
  }
  return lines.join('\n');
}
