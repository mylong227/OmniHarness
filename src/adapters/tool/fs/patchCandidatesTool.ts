import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DecisionEngine } from '../../../ports/decision/decisionEngine.ts';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.ts';
import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import { ShellChildEnv } from '../../tool/shell/shellChildEnv.ts';
import { ShellProcessRunner } from '../../tool/shell/shellProcessRunner.ts';
import { SelfVerifyPolicy } from '../verify/selfVerifyPolicy.ts';
import { PatchApplier } from './patchApplier.ts';
import { ToolWorkspaceRoot } from '../../../util/toolWorkspaceRoot.ts';
import { WorkspaceGuard } from '../../../util/workspaceGuard.ts';
import { log } from '../../../util/logger.ts';
import { WorkspaceFileCoordinator, type FileWriteLease } from './workspaceFileCoordinator.ts';

/** 单个候选补丁的评估结果（未跑测试前）。 */
interface Candidate {
  /** 候选序号（0 起，对应模型入参顺序）。 */
  readonly index: number;
  /** 原始 diff。 */
  readonly patch: string;
  /** 目标相对路径 → 应用后内容。 */
  readonly outputs: ReadonlyMap<string, string>;
  /** 目标相对路径 → 应用前内容（不存在时为 undefined）。 */
  readonly originals: ReadonlyMap<string, string | undefined>;
  /** 语义体量（新增/删除字符数近似；用于同分时选小改动）。 */
  readonly size: number;
}

/** 单候选的真实测试结果。 */
interface CandidateRun {
  /** 候选序号。 */
  readonly index: number;
  /** 测试是否通过。 */
  readonly passed: boolean;
  /** 退出码（超时/信号终止时为 null）。 */
  readonly exitCode: number | null;
  /** 是否超时。 */
  readonly timedOut: boolean;
  /** 人类可读摘要。 */
  readonly note: string;
}

/** 工具构造选项（测试注入用）。 */
export interface PatchCandidatesToolOptions {
  /** 测试命令执行器（缺省真实 `ShellProcessRunner`）。 */
  readonly runner?: Pick<ShellProcessRunner, 'run'> | undefined;
  /** 可选的 System-1 决策引擎（LaYa）：同分候选的最后一层 tie-breaker。 */
  readonly decisionEngine?: DecisionEngine | undefined;
  /** 配置层解析好的测试策略；缺省按工作区证据探测（模型不能自带命令）。 */
  readonly policy?: SelfVerifyPolicy | undefined;
}

/** 单次多候选验证的总测试预算（毫秒）：最多 3 候选，防止串联测试把回合拖死。 */
const MAX_TOTAL_TEST_MS = 600_000;

/**
 * 多候选补丁验证工具（P1 · Agentless 式 repair→validation）。
 *
 * 模型一次提交 2–3 份 unified diff；本工具：
 * 1. **先全部解析/试算**，非法候选在写盘前淘汰；
 * 2. 逐候选临时写入工作区 → 跑真实测试 → `finally` 恢复原文件；
 * 3. 只把**最优候选**真正写回工作区（测试通过 > LaYa noul > 改动体量）；
 * 4. 全部失败 ⇒ 一个字节都不落盘，并返回每候选的失败摘要。
 *
 * 安全边界：路径必须落在工作区；测试命令沿用 `SelfVerifyPolicy` 的探测/显式命令与预算；
 * 工具本身是写类（进 `MUTATING_TOOL_NAMES`，受审批/沙箱/串行屏障约束）。
 */
export class PatchCandidatesTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.patchCandidates,
    description:
      '多候选补丁验证：提交 2–3 个 unified diff，逐候选在真实测试上验证，只把最优候选写回工作区。' +
      '全部候选失败则不落盘；适合“先修 bug，再比较多个修复方案”的场景。',
    parameters: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: '2–3 份 unified diff（每份可多文件；相对当前工作区）',
        },
        timeout_ms: {
          type: 'number',
          description: '单候选测试超时（毫秒；缺省取 SelfVerifyPolicy 预算，封顶 300000）',
        },
      },
      required: ['candidates'],
    },
  };

  /** 真实测试执行器。 */
  private readonly runner: Pick<ShellProcessRunner, 'run'>;
  /** LaYa 决策引擎（可选，只做 tie-breaker）。 */
  private readonly decisionEngine: DecisionEngine | undefined;
  /** 配置层测试策略（模型不可自带测试命令，避免把补丁审批变成任意命令执行）。 */
  private readonly policy: SelfVerifyPolicy | undefined;

  /**
   * @param workspaceRoot 工作区根（子智能体按 `ToolContext.workspaceRoot` 覆盖）。
   * @param options 测试执行器 / 决策引擎（测试注入）。
   */
  public constructor(
    private readonly workspaceRoot: string,
    options: PatchCandidatesToolOptions = {},
  ) {
    this.runner = options.runner ?? new ShellProcessRunner();
    this.decisionEngine = options.decisionEngine;
    this.policy = options.policy;
  }

  /**
   * 执行多候选验证。
   * @param call 工具调用（candidates / test_command / timeout_ms）。
   * @param context 工具上下文（workspaceRoot / sessionId）。
   * @returns 成败结果；成功时附每候选摘要与最终选中的候选序号。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const candidates = this.readCandidates(call);
    if (typeof candidates === 'string') {
      return { callId: call.id, ok: false, error: candidates };
    }
    const root = ToolWorkspaceRoot.of(this.workspaceRoot, context);
    const guard = new WorkspaceGuard(root);
    const parsed: Candidate[] = [];
    const invalid: { readonly index: number; readonly error: string }[] = [];
    for (const [index, patch] of candidates.entries()) {
      const result = await this.prepareCandidate(root, guard, index, patch);
      if (typeof result === 'string') {
        invalid.push({ index, error: result });
      } else {
        parsed.push(result);
      }
    }
    if (parsed.length === 0) {
      return {
        callId: call.id,
        ok: false,
        error: `全部候选在写盘前被淘汰：${invalid.map((item) => `#${String(item.index)} ${item.error}`).join('；')}`,
      };
    }
    const command = this.resolveCommand(root);
    if (typeof command === 'string') {
      return { callId: call.id, ok: false, error: command };
    }
    const timeoutMs = this.timeoutOf(command, call);
    const runs: CandidateRun[] = [];
    const deadline = Date.now() + MAX_TOTAL_TEST_MS;
    for (const candidate of parsed) {
      runs.push(await this.runCandidate(root, candidate, command, timeoutMs, deadline));
    }
    const chosen = await this.choose(parsed, runs);
    if (chosen === undefined) {
      return {
        callId: call.id,
        ok: false,
        error:
          `全部候选均未通过真实测试，工作区已恢复原状：${runs
            .map((run) => `#${String(run.index)} ${run.note}`)
            .join('；')}` +
          (invalid.length > 0
            ? `；写盘前淘汰：${invalid.map((item) => `#${String(item.index)} ${item.error}`).join('；')}`
            : ''),
      };
    }
    const applied = await this.applyChosen(root, chosen);
    if (!applied.ok) {
      return { callId: call.id, ok: false, error: applied.error };
    }
    const summary = runs
      .map(
        (run) =>
          `#${String(run.index)} ${run.passed ? 'PASS' : 'FAIL'}${run.exitCode === null ? '' : ` exit=${String(run.exitCode)}`}${run.timedOut ? ' timeout' : ''}`,
      )
      .join('；');
    return {
      callId: call.id,
      ok: true,
      output:
        `已选候选 #${String(chosen.index)}（${summary}）\n` +
        `写回文件：${[...chosen.outputs.keys()].join('、')}\n` +
        (invalid.length > 0
          ? `写盘前淘汰：${invalid.map((item) => `#${String(item.index)} ${item.error}`).join('；')}`
          : ''),
    };
  }

  /**
   * 读取并校验候选数组（2–3 个非空字符串，单个长度 ≤ 128 KiB）。
   * @param call 工具调用。
   * @returns 候选文本数组，或可读错误。
   */
  private readCandidates(call: ToolCall): readonly string[] | string {
    const raw = call.arguments['candidates'];
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) {
      return 'candidates 必须是 2–3 元字符串数组（每项一份 unified diff）';
    }
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item.trim() === '') {
        return '每个候选必须是非空 unified diff 字符串';
      }
      if (item.length > 128 * 1024) {
        return '单个候选补丁超过 128 KiB 上限';
      }
      out.push(item);
    }
    return out;
  }

  /**
   * 解析/试算一个候选（不写盘）。
   * @param root 工作区根。
   * @param guard 路径守卫。
   * @param index 候选序号。
   * @param patch diff 文本。
   * @returns 候选对象，或可读错误。
   */
  private async prepareCandidate(
    root: string,
    guard: WorkspaceGuard,
    index: number,
    patch: string,
  ): Promise<Candidate | string> {
    const parsed = new PatchApplier().parseFiles(patch);
    if (!parsed.ok) return `解析失败：${parsed.error}`;
    const targets = parsed.files.map((file) => file.targetFile).filter((target) => target !== '');
    if (targets.length === 0) return '缺少 +++ 目标文件';
    const originals = new Map<string, string | undefined>();
    for (const target of targets) {
      if (!guard.isInside(target)) return `路径越界：${target}`;
      const absolute = resolve(root, target);
      try {
        originals.set(target, existsSync(absolute) ? await readFile(absolute, 'utf8') : undefined);
      } catch (error) {
        return `读取目标失败：${target}（${this.messageOf(error)}）`;
      }
    }
    const applied = new PatchApplier().applyMany(
      new Map([...originals].map(([target, content]) => [target, content ?? ''])),
      patch,
    );
    if (!applied.ok) return `应用失败：${applied.error}`;
    const outputs = new Map<string, string>();
    let size = 0;
    for (const output of applied.outputs) {
      outputs.set(output.targetFile, output.content);
      size += Math.abs(output.content.length - (originals.get(output.targetFile) ?? '').length);
    }
    return { index, patch, outputs, originals, size };
  }

  /**
   * 解析测试策略：配置层策略 > 仓库证据探测；不读取模型提供的命令。
   * @param root 工作区根。
   * @returns 生效策略，或可读错误。
   */
  private resolveCommand(root: string): SelfVerifyPolicy | string {
    return (
      this.policy ??
      SelfVerifyPolicy.forWorkspace(root) ??
      '仓库没有可探测的测试命令；请启用 selfVerify 或配置测试命令'
    );
  }

  /**
   * 临时写入候选 → 跑真实测试 → 恢复原文件。
   * @param root 工作区根。
   * @param candidate 已试算候选。
   * @param command 自验证策略。
   * @returns 测试结果。
   */
  private async runCandidate(
    root: string,
    candidate: Candidate,
    command: SelfVerifyPolicy,
    timeoutMs: number,
    deadline: number,
  ): Promise<CandidateRun> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        index: candidate.index,
        passed: false,
        exitCode: null,
        timedOut: true,
        note: '总测试预算耗尽，未运行',
      };
    }
    const coordinator = WorkspaceFileCoordinator.of(root);
    const absolutes = [...candidate.outputs.keys()].map((target) => resolve(root, target));
    try {
      // 候选验证**全程持有目标文件写锁**：临时写入 → 跑测试 → 恢复原文，期间别的会话
      // 不得改同一文件（否则测试结果与恢复都会建立在他人的并发修改上）。
      return await coordinator.withWriteMany(absolutes, async (leases) => {
        try {
          const conflict = await this.writeOutputs(root, candidate, leases);
          if (conflict !== undefined) {
            return {
              index: candidate.index,
              passed: false,
              exitCode: null,
              timedOut: false,
              note: conflict,
            };
          }
          const effectiveTimeout = Math.min(timeoutMs, remaining);
          const outcome = await this.runner.run(command.command, {
            cwd: root,
            env: ShellChildEnv.clean(),
            timeoutMs: effectiveTimeout,
            maxBufferBytes: command.maxOutputBytes,
          });
          const passed =
            outcome.exitCode === 0 && !outcome.timedOut && !outcome.aborted && !outcome.overflowed;
          return {
            index: candidate.index,
            passed,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            note: passed
              ? '测试通过'
              : outcome.timedOut
                ? `超时（${String(timeoutMs)}ms）`
                : `失败（exit=${String(outcome.exitCode ?? 'null')}，aborted=${String(outcome.aborted)}，overflowed=${String(outcome.overflowed)}）`,
          };
        } finally {
          await this.restore(root, candidate, leases);
        }
      });
    } catch (error) {
      return {
        index: candidate.index,
        passed: false,
        exitCode: null,
        timedOut: false,
        note: `未运行：${this.messageOf(error)}`,
      };
    }
  }

  /**
   * 选择最优候选：通过 > 改动体量（小者）> LaYa noul（高者）> 序号。
   *
   * LaYa 只处理**同体量**的平局；2026-10-18 真实小样本 A/B（6 候选）AUC=0.600、
   * top1 错——尚不足以让它越过「更小改动」这条确定性信号。
   * @param candidates 已试算候选。
   * @param runs 测试结果。
   * @returns 胜出候选；全失败时为 undefined。
   */
  private async choose(
    candidates: readonly Candidate[],
    runs: readonly CandidateRun[],
  ): Promise<Candidate | undefined> {
    const passed = runs.filter((run) => run.passed);
    if (passed.length === 0) return undefined;
    const candidatesByIndex = new Map(candidates.map((candidate) => [candidate.index, candidate]));
    if (passed.length === 1) {
      return candidatesByIndex.get(passed[0]?.index ?? -1);
    }
    const scored = passed
      .map((run) => candidatesByIndex.get(run.index))
      .filter((candidate): candidate is Candidate => candidate !== undefined);
    const minSize = Math.min(...scored.map((candidate) => candidate.size));
    const tied = scored.filter((candidate) => candidate.size === minSize);
    if (tied.length === 1) return tied[0];
    const ranked: { candidate: Candidate; noul: number | undefined }[] = [];
    for (const candidate of tied) {
      ranked.push({ candidate, noul: await this.noulOf(candidate) });
    }
    ranked.sort((left, right) => {
      if (left.noul === right.noul) return left.candidate.index - right.candidate.index;
      if (left.noul === undefined) return 1;
      if (right.noul === undefined) return -1;
      return right.noul - left.noul;
    });
    return ranked[0]?.candidate;
  }

  /**
   * 可选 LaYa tie-breaker：只用 `noul` 预测，不改变测试真值。
   * @param candidate 候选。
   * @returns 预判概率；不可用/失败时为 undefined（fail-open）。
   */
  private async noulOf(candidate: Candidate): Promise<number | undefined> {
    const engine = this.decisionEngine;
    if (engine === undefined) return undefined;
    try {
      if (!(await engine.isAvailable())) return undefined;
      const response = await engine.decide({
        state:
          `candidate patch (${String(candidate.size)} chars changed):\n` +
          candidate.patch.slice(0, 8_000),
        questions: {
          passTest: { kind: 'noul', instructions: '这份候选补丁会跑通既有测试吗？' },
        },
      });
      if (!response.available) return undefined;
      const noul = response.answers['passTest']?.noul;
      return typeof noul === 'number' && Number.isFinite(noul) ? noul : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 把候选内容写入工作区（临时验证阶段；调用方必须已持有全部目标写锁）。
   *
   * 写入前逐目标核对「当前内容 == 候选基于的原文」：不一致说明候选是在旧内容上算出来的，
   * 直接写会把别人的改动覆盖掉——此时整批不写，让该候选判为未运行。
   * @param root 工作区根。
   * @param candidate 候选。
   * @param leases 目标绝对路径 → 写租约。
   * @returns 冲突/错误文案；成功时 undefined。
   */
  private async writeOutputs(
    root: string,
    candidate: Candidate,
    leases: ReadonlyMap<string, FileWriteLease>,
  ): Promise<string | undefined> {
    for (const [target] of candidate.outputs) {
      const lease = leases.get(resolve(root, target));
      if (lease === undefined) return `目标未持锁: ${target}`;
      const current = await lease.read();
      if (current !== candidate.originals.get(target)) {
        return `目标 ${target} 在候选计算后被修改，已放弃写入（请重读后重发候选）`;
      }
    }
    for (const [target, content] of candidate.outputs) {
      const lease = leases.get(resolve(root, target));
      if (lease === undefined) return `目标未持锁: ${target}`;
      await lease.write(content);
    }
    return undefined;
  }

  /**
   * 恢复候选前的文件状态（调用方仍持有全部目标写锁；测试自身改文件也一并恢复）。
   * @param root 工作区根。
   * @param candidate 候选。
   * @param leases 目标绝对路径 → 写租约。
   * @returns 无返回值。
   */
  private async restore(
    root: string,
    candidate: Candidate,
    leases: ReadonlyMap<string, FileWriteLease>,
  ): Promise<void> {
    for (const [target, content] of candidate.originals) {
      const lease = leases.get(resolve(root, target));
      try {
        if (lease === undefined) throw new Error(`目标未持锁: ${target}`);
        if (content === undefined) {
          await lease.remove();
        } else {
          await lease.write(content);
        }
      } catch (error) {
        log.warn('tool.patch_candidates.restore.failed', {
          target,
          error: this.messageOf(error),
        });
      }
    }
  }

  /**
   * 把胜出候选正式写回工作区（含 `.bak` 备份；失败回滚）。
   *
   * 与临时验证阶段同一把锁：写回前核对「当前内容 == 候选原文」，防止在候选跑测试期间
   * 别的会话改了目标文件后仍被候选覆盖。
   * @param root 工作区根。
   * @param chosen 胜出候选。
   * @returns 成功/失败。
   */
  private async applyChosen(
    root: string,
    chosen: Candidate,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    const coordinator = WorkspaceFileCoordinator.of(root);
    const absolutes = [...chosen.outputs.keys()].map((target) => resolve(root, target));
    try {
      await coordinator.withWriteMany(absolutes, async (leases) => {
        for (const [target] of chosen.outputs) {
          const lease = leases.get(resolve(root, target));
          if (lease === undefined) throw new Error(`目标未持锁: ${target}`);
          if ((await lease.read()) !== chosen.originals.get(target)) {
            throw new Error(`目标 ${target} 在候选验证期间被其他会话修改，已放弃写回`);
          }
        }
        try {
          for (const [target, content] of chosen.outputs) {
            const lease = leases.get(resolve(root, target));
            if (lease === undefined) throw new Error(`目标未持锁: ${target}`);
            await lease.backup();
            await lease.write(content);
          }
        } catch (error) {
          await this.restore(root, chosen, leases);
          throw error;
        }
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `写回候选失败: ${this.messageOf(error)}` };
    }
  }

  /**
   * 单候选测试超时：显式 `timeout_ms` > policy；封顶 300s，下限 1s。
   * @param policy 自验证策略。
   * @returns 毫秒。
   */
  private timeoutOf(policy: SelfVerifyPolicy, call: ToolCall): number {
    const raw = call.arguments['timeout_ms'];
    const requested =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : policy.timeoutMs;
    return Math.min(policy.timeoutMs, Math.max(1_000, requested));
  }

  /**
   * 把任意错误整理成一句可读原因。
   * @param error 捕获值。
   * @returns 原因文本。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
