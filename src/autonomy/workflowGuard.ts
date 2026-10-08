import { WorkflowSpecError } from './workflowSpecError.js';
import { WorkflowStepStatuses } from './workflowStepStatuses.js';
import type { WorkflowStepGuard } from '../ports/autonomy/workflowStepGuard.js';
import type { WorkflowStep } from '../ports/autonomy/workflowStep.js';
import type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.js';

/** 条件裁决结果。 */
export interface WorkflowGuardVerdict {
  /** 条件是否成立（成立才执行本步）。 */
  readonly run: boolean;
  /** 不成立时的可读原因（写进步骤结果与运行日志，供事后审计）。 */
  readonly reason: string;
}

/**
 * @beta
 * 受控执行条件（`when`）的**校验与裁决**：把「分支」表达力压进静态 DAG，不引入条件边与环。
 *
 * ## 为什么单独成类
 *
 * 校验（规格期，fail-closed）与裁决（运行期，纯函数）是同一件事的两面，且都被
 * `WorkflowRunner` 使用；留在 runner 里会让那个类越过「上帝类」成员数判据
 * （`scripts/auditStandards.mjs`：含类文件 >25 成员即红）。按本仓惯例抽出去。
 *
 * ## 一条纪律（来自本仓最高频缺陷形态）
 *
 * 条件里的**引用必须在校验期解析干净**：指向不存在的步骤、指向未在 `dependsOn` 声明的步骤、
 * 非法终态、编译不了的正则——一律在**开始执行之前**拒绝（`WorkflowSpecError`）。
 * 若留到运行期，表现会是「这一步永远跳过」或「读到陈旧状态」，两者都不会报错。
 */
export class WorkflowGuard {
  /**
   * 校验整份定义里的全部 `when` 条件（fail-closed，任一非法即抛）。
   *
   * @param steps 工作流步骤列表。
   * @returns 无返回值。
   * @throws WorkflowSpecError 引用不存在步骤 / 未在 dependsOn 声明 / 自引用 / 非法终态 / 正则不可编译时抛出。
   */
  public static validate(steps: readonly WorkflowStep[]): void {
    const byId = new Map(steps.map((step) => [step.id, step]));
    for (const step of steps) {
      const guard = step.when;
      if (guard === undefined) {
        continue;
      }
      WorkflowGuard.requireGuardShape(guard, step);
      if (!byId.has(guard.step)) {
        throw new WorkflowSpecError(
          `步骤「${step.id}」的 when.step 指向不存在的步骤「${guard.step}」（可用：${[...byId.keys()].join('、')}）`,
        );
      }
      if (guard.step === step.id) {
        throw new WorkflowSpecError(
          `步骤「${step.id}」的 when 不得引用自身（会永真/永假且无从调度）`,
        );
      }
      if (!(step.dependsOn ?? []).includes(guard.step)) {
        throw new WorkflowSpecError(
          `步骤「${step.id}」的 when.step「${guard.step}」必须同时出现在 dependsOn 中——` +
            '否则「观察该步状态」没有调度顺序保证，会读到上一轮的陈旧状态',
        );
      }
      if (!WorkflowStepStatuses.GUARDABLE.includes(guard.status)) {
        throw new WorkflowSpecError(
          `步骤「${step.id}」的 when.status 只能是 ${WorkflowStepStatuses.GUARDABLE.join(' / ')}` +
            `（收到「${guard.status}」；blocked / cancelled 属基础设施故障，不可当分支条件）`,
        );
      }
      WorkflowGuard.requirePattern(guard, step);
    }
  }

  /**
   * 裁决一条条件：观察步骤的终态（可选叠加产出正则）是否命中。
   *
   * @param guard 条件声明（已通过 {@link validate}）。
   * @param statuses 本次运行已记录的步骤终态。
   * @param outputs 本次运行已记录的步骤产出（用于 `outputMatches`）。
   * @returns 裁决结果（`run:false` 时 `reason` 为可读原因）。
   */
  public static decide(
    guard: WorkflowStepGuard,
    statuses: ReadonlyMap<string, WorkflowStepStatus>,
    outputs: Readonly<Record<string, string>>,
  ): WorkflowGuardVerdict {
    const actual = statuses.get(guard.step);
    if (actual === undefined) {
      // 不应发生：validate 已强制 guard.step 在 dependsOn 中，调度顺序保证它先有终态。
      // 真发生时按「不成立 + 明确原因」处理（fail-closed，绝不默认执行）。
      return { run: false, reason: `条件未成立：被观察步骤「${guard.step}」尚无终态记录` };
    }
    if (actual !== guard.status) {
      return {
        run: false,
        reason: `条件未成立：步骤「${guard.step}」终态为 ${actual}，条件要求 ${guard.status}`,
      };
    }
    if (guard.outputMatches === undefined) {
      return { run: true, reason: '' };
    }
    const output = outputs[guard.step] ?? '';
    const matched = new RegExp(guard.outputMatches).test(output);
    return matched
      ? { run: true, reason: '' }
      : {
          run: false,
          reason: `条件未成立：步骤「${guard.step}」产出不匹配 /${guard.outputMatches}/`,
        };
  }

  /**
   * 校验条件对象的形状（字段存在性与终态枚举），非法即抛。
   *
   * @param guard 条件声明（来自模型输入，故按 `unknown` 口径校验）。
   * @param step 声明该条件的步骤（用于错误定位）。
   * @returns 无返回值。
   * @throws WorkflowSpecError 形状非法时抛出。
   */
  private static requireGuardShape(guard: unknown, step: WorkflowStep): void {
    if (typeof guard !== 'object' || guard === null || Array.isArray(guard)) {
      throw new WorkflowSpecError(`步骤「${step.id}」的 when 必须是对象 { step, status }`);
    }
    const shape = guard as Partial<WorkflowStepGuard>;
    if (typeof shape.step !== 'string' || shape.step.length === 0) {
      throw new WorkflowSpecError(`步骤「${step.id}」的 when.step 必须是非空字符串`);
    }
    if (typeof shape.status !== 'string' || shape.status.length === 0) {
      throw new WorkflowSpecError(
        `步骤「${step.id}」的 when.status 必须是非空字符串（${WorkflowStepStatuses.GUARDABLE.join(' / ')}）`,
      );
    }
    if (shape.outputMatches !== undefined && typeof shape.outputMatches !== 'string') {
      throw new WorkflowSpecError(`步骤「${step.id}」的 when.outputMatches 必须是字符串（正则源）`);
    }
  }

  /**
   * 校验 `outputMatches`：只有 `status:'done'` 才允许声明，且必须能编译成正则。
   *
   * @param guard 条件声明。
   * @param step 声明该条件的步骤。
   * @returns 无返回值。
   * @throws WorkflowSpecError 组合非法或正则不可编译时抛出。
   */
  private static requirePattern(guard: WorkflowStepGuard, step: WorkflowStep): void {
    if (guard.outputMatches === undefined) {
      return;
    }
    if (guard.status !== 'done') {
      throw new WorkflowSpecError(
        `步骤「${step.id}」在 when.status="${guard.status}" 上声明了 outputMatches——` +
          '该状态没有产出，条件永不成立（哑条件），请改为 status:"done" 或删除 outputMatches',
      );
    }
    try {
      new RegExp(guard.outputMatches);
    } catch (error) {
      throw new WorkflowSpecError(
        `步骤「${step.id}」的 when.outputMatches 不是合法正则：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
