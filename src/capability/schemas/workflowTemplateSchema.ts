/**
 * 第二个资产类型描述符：工作流模板（`workflow-template`）。
 *
 * ## 为什么第二个类型是它（而不是洞察 / 任务集）
 *
 * §7 Wave B 的验收判据点名「新类型（工作流模板）注册 → 评估 → 晋升端到端走通」。
 * 它恰好是**与技能同构但不同度量**的类型：技能是「一段注入文本」，模板是「一串有前置条件与
 * 产出断言的有序步骤」——用它来证明协议**真的对类型开放**，而不是「只有 skill 能用」。
 *
 * ## 度量怎么定（Ω-4：由类型作者声明）
 *
 * 模板的「好坏」在本仓语境里是**可执行性**：步骤非空且每步都有动作、依赖的前置条件（`requires`）
 * 都在模板自身的产出（`produces`）或外部输入（`inputs`）里能得到满足、且没有悬空依赖。
 * 故基准 = **满足率**（已满足依赖数 / 全部依赖数，0..1，无依赖时恒 1）——纯函数、确定性、
 * 与技能那条线（莫尔能量）**互不干扰**：这正是「在正确空间比较」的落地。
 *
 * @maturity L1 — 校验与依赖满足度判据钉死（含悬空依赖即降分/非模板恒 0 的负例）
 * @maturityEvidence tests/unit/workflowTemplateSchema.test.ts
 */
import type {
  AssetBenchmark,
  CapabilitySchema,
  EvalContext,
  SchemaValidation,
} from '../../ports/capability.js';

/** 模板步骤（声明式：动作 + 依赖 + 产出）。 */
export interface WorkflowStep {
  /** 步骤名（模板内唯一）。 */
  readonly name: string;
  /** 该步做什么（单行描述，供执行体解析）。 */
  readonly action: string;
  /** 前置依赖：所需的外部输入名或前序步骤的产出名。 */
  readonly requires: readonly string[];
  /** 本步产出（名字列表，可为空）。 */
  readonly produces: readonly string[];
}

/** 工作流模板本体。 */
export interface WorkflowTemplate {
  /** 模板名（资产名）。 */
  readonly name: string;
  /** 模板用途描述。 */
  readonly description: string;
  /** 模板外部输入（不在 `produces` 里但被 `requires` 引用的名字必须在此声明）。 */
  readonly inputs: readonly string[];
  /** 有序步骤。 */
  readonly steps: readonly WorkflowStep[];
}

/** 工作流模板类型描述符。 */
export class WorkflowTemplateSchema implements CapabilitySchema {
  /** 类型键。 */
  public readonly kind = 'workflow-template';
  /** 契约版本。 */
  public readonly version = 1;
  /** 默认信任档：模板是**声明式数据**（本身不执行代码）⇒ 内置档起步；进化产物由注册表收紧。 */
  public readonly defaultTrustTier = 'core' as const;
  /** 默认隔离档：模板由 harness 解释执行，不需要额外隔离档（沿 Skill 的同一理由）。 */
  public readonly defaultIsolation = 'in-process' as const;
  /** 台账语义：与技能同链、同快照粒度（当前唯一种）。 */
  public readonly ledgerSemantics = { chain: 'promotion', snapshot: 'registry-full' } as const;

  /**
   * 结构校验：名字/描述非空、至少一步、每步三字段齐备、名字不重复、引用不悬空。
   * @param asset 待校验资产
   * @returns 校验结论（失败带可行动原因）
   */
  public validate(asset: unknown): SchemaValidation {
    if (typeof asset !== 'object' || asset === null) {
      return { ok: false, reason: '模板资产必须是对象' };
    }
    const template = asset as Partial<WorkflowTemplate>;
    for (const field of ['name', 'description'] as const) {
      const value = template[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, reason: `模板字段 ${field} 缺失或为空` };
      }
    }
    const steps = template.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, reason: '模板 steps 必须是非空数组' };
    }
    const inputs = template.inputs;
    if (!Array.isArray(inputs) || inputs.some((v) => typeof v !== 'string')) {
      return { ok: false, reason: '模板 inputs 必须是字符串数组（可为空数组）' };
    }
    const seen = new Set<string>();
    for (const step of steps) {
      const verdict = WorkflowTemplateSchema.validateStep(step);
      if (verdict !== undefined) return { ok: false, reason: verdict };
      const name = (step as WorkflowStep).name;
      if (seen.has(name)) return { ok: false, reason: `模板步骤名重复: ${name}` };
      seen.add(name);
    }
    const produceable = new Set<string>(inputs);
    for (const step of steps as readonly WorkflowStep[]) {
      for (const requirement of step.requires) {
        if (!produceable.has(requirement)) {
          return {
            ok: false,
            reason: `步骤 ${step.name} 依赖悬空: ${requirement}（既非 inputs 也非前序产出）`,
          };
        }
      }
      for (const produced of step.produces) produceable.add(produced);
    }
    return { ok: true };
  }

  /**
   * 单步校验（结构面）。
   * @param step 待校验步骤
   * @returns 失败原因；通过为 undefined
   */
  private static validateStep(step: unknown): string | undefined {
    if (typeof step !== 'object' || step === null) return '模板每一步必须是对象';
    const candidate = step as Partial<WorkflowStep>;
    for (const field of ['name', 'action'] as const) {
      const value = candidate[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return `模板步骤字段 ${field} 缺失或为空`;
      }
    }
    for (const field of ['requires', 'produces'] as const) {
      const value = candidate[field];
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return `模板步骤字段 ${field} 必须是字符串数组`;
      }
    }
    return undefined;
  }

  /**
   * 评估契约：依赖满足率（0..1；无依赖恒 1）。
   * @param _ctx 评估上下文（本类型的度量与评估器标识无关）
   * @returns 资产级基准函数（非法资产恒 0——fail-closed）
   */
  public evalContract(_ctx: EvalContext): AssetBenchmark {
    return (asset: unknown): number => {
      if (!this.validate(asset).ok) return 0;
      return WorkflowTemplateSchema.satisfactionOf(asset as WorkflowTemplate);
    };
  }

  /**
   * 依赖满足率（纯函数；`validate` 已保证无悬空依赖，故合法模板恒 1——**这正是判据的一部分**：
   * 「合法性」与「可执行性」在本类型里是同一件事，度量不与校验各说各话）。
   * @param template 工作流模板
   * @returns 0..1
   */
  public static satisfactionOf(template: WorkflowTemplate): number {
    const available = new Set<string>(template.inputs);
    let total = 0;
    let satisfied = 0;
    for (const step of template.steps) {
      for (const requirement of step.requires) {
        total++;
        if (available.has(requirement)) satisfied++;
      }
      for (const produced of step.produces) available.add(produced);
    }
    return total === 0 ? 1 : satisfied / total;
  }
}
