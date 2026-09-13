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
import { PatchApplier } from '../adapters/tool/patchApplier.js';
import type { ModelPort } from '../ports/model/model.js';
import type { ScriptStep } from './scriptedModel.js';

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
  readonly reason?: string;
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

// ---------- 工作区预置（各模式共用）----------

function seedWorkspace(task: SweTask, workspaceRoot: string): void {
  for (const [rel, content] of Object.entries(task.seedFiles)) {
    const fp = join(workspaceRoot, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content, 'utf8');
  }
}

// ---------- 模式一：确定性基建（ScriptedModel replay）----------

/**
 * @beta
 * 跑单条任务：预置文件 → 真实 Agent（给定 model）→ 执行 → 跑 evalCmd 评分。
 * model 由调用方构造（scripted 或 live），本函数不耦合具体模型实现。
 */
export async function runSweTask(
  task: SweTask,
  workspaceRoot: string,
  model: ModelPort,
  mode: 'scripted' | 'live',
): Promise<SweTaskResult> {
  seedWorkspace(task, workspaceRoot);

  const config = ConfigFactory.build({
    workspaceRoot,
    maxSteps: task.maxSteps ?? 16,
    model,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
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
    };
  }

  const exit = runEval(task.evalCmd, workspaceRoot);
  const passed = scoreSweResult(exit);
  return {
    id: task.id,
    passed,
    evalExitCode: exit,
    mode,
    steps: result.steps,
    reason: passed ? undefined : `evalCmd 退出码 ${exit}（修复未达 FAIL_TO_PASS）`,
  };
}

// ---------- 对照：阳性（goldPatch 必过）/ 阴性（不修复必不过）----------

/**
 * @beta
 * 阳性对照：直接套用 goldPatch（绕过 agent），评分器必须判过。证明评分器不假阴。
 */
export async function runGoldControl(task: SweTask, workspaceRoot: string): Promise<SweTaskResult> {
  seedWorkspace(task, workspaceRoot);
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
      };
    }
    writeFileSync(fp, applied.newContent ?? '', 'utf8');
  }
  const exit = runEval(task.evalCmd, workspaceRoot);
  const passed = scoreSweResult(exit);
  return {
    id: task.id,
    passed,
    evalExitCode: exit,
    mode: 'control',
    steps: 0,
    reason: passed ? undefined : `goldPatch 套用后仍 FAIL_TO_PASS 未过（任务定义或评分器有误）`,
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
  seedWorkspace(task, workspaceRoot);
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
 */
export async function runControls(
  tasks: readonly SweTask[],
  opts?: { readonly workspaceRoot?: string },
): Promise<SweControlReport> {
  const own = opts?.workspaceRoot === undefined;
  const root = opts?.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'omni-swe-ctrl-'));
  const gold: SweTaskResult[] = [];
  const negative: SweTaskResult[] = [];
  try {
    for (const task of tasks) {
      const g = await runGoldControl(task, mkdtempSync(join(root, `g-${task.id}-`)));
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
 */
export async function runSweSuite(
  suiteName: string,
  tasks: readonly SweTask[],
  model: ModelPort | null,
  mode: 'scripted' | 'live',
  opts?: { readonly workspaceRoot?: string; readonly modelFor?: (task: SweTask) => ModelPort },
): Promise<SweReport> {
  const own = opts?.workspaceRoot === undefined;
  const root = opts?.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'omni-swe-'));
  const results: SweTaskResult[] = [];
  const t0 = Date.now();
  try {
    for (const task of tasks) {
      const ws = mkdtempSync(join(root, `${task.id}-`));
      const m = opts?.modelFor !== undefined ? opts.modelFor(task) : (model as ModelPort);
      results.push(await runSweTask(task, ws, m, mode));
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
 */
export function formatSweReport(report: SweReport, controls?: SweControlReport): string {
  const lines: string[] = [];
  lines.push(`=== SWE 能力套件: ${report.suite} (mode=${report.mode}) ===`);
  for (const r of report.results) {
    const mark = r.passed ? '✅' : '❌';
    lines.push(`${mark} ${r.id}  steps=${r.steps}  evalExit=${r.evalExitCode}`);
    if (!r.passed && r.reason !== undefined) lines.push(`     - ${r.reason}`);
  }
  lines.push(
    `--- 汇总: ${report.passed}/${report.total} 通过, 失败 ${report.failed}, 总耗时 ${report.totalDurationMs}ms ---`,
  );
  if (controls !== undefined) {
    lines.push(`=== 对照有效性: ${controls.valid ? '✅ 有效' : '❌ 失效'} ===`);
    for (const g of controls.gold) {
      lines.push(`  [阳性] ${g.id}: ${g.passed ? '✅ 过' : `❌ ${g.reason ?? ''}`}`);
    }
    for (const n of controls.negative) {
      lines.push(`  [阴性] ${n.id}: ${!n.passed ? '✅ 不过(正确)' : `❌ ${n.reason ?? ''}`}`);
    }
  }
  return lines.join('\n');
}
