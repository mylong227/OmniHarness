/**
 * CRISPR 精确技能编辑器（P2, I-P2-4）。
 *
 * 实现 `CRISPRSkillEditorPort`：以 `SkillPort` 为编辑面，对既有技能做定点 patch——
 * - **语义寻址（skill-RNA）**：精确名优先；否则用燧-3 频率域共振（eigenSpectrum/resonance）
 *   在技能 instructions 本征谱上比对目标描述，取共振最强者。
 * - **定点 patch**：仅改写 `instructions`（描述同步派生，避免契约漂移），不动其它字段。
 * - **差异测试 + 回滚（防脱靶，fail-closed）**：patch 后若 `differentialTest` 不通过，
 *   绝不提交、原技能保持不变，报告 `rolledBack=true`。
 *
 * 零依赖（共振复用 燧-3 的 util/eigenspectrum），异常不影响调用方。
 *
 * @maturity L0 — 技能改写；非基因编辑
 * @maturityEvidence tests/unit/crispr.test.ts
 */
import type { Skill } from '../../skill/skill.js';
import type { SkillPort } from '../../ports/runtime/skill.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenspectrum.js';
import type { AuditSinkLike } from '../../ports/runtime/supervisor.js';
import type {
  CRISPRSkillEditorPort,
  CrisprEditReport,
  CrisprEditSpec,
} from '../../ports/runtime/skillEdit.js';

/** CRISPRSkillEditor 选项。 */
export interface CRISPRSkillEditorOptions {
  /** 编辑面（通常是受种的 SkillRegistry）。 */
  readonly skillPort: SkillPort;
  /** 可选审计链：编辑/回滚事件入链（与免疫监控同机制）。 */
  readonly audit?: AuditSinkLike | undefined;
  /** 语义寻址共振阈值（默认 0.5）。 */
  readonly addressThreshold?: number | undefined;
  /** 能力场维度（默认 257，须与燧-3 一致）。 */
  readonly bins?: number | undefined;
}

/** 把改写后的 instructions 派生出描述，保持契约一致（不硬塞原文，避免描述失配）。 */
function deriveDescription(original: string, patched: string): string {
  if (original === patched) return original;
  return `${original}（已 CRISPR 定点修订）`;
}

/** 安全执行差异测试：测试函数抛错一律视为不通过（fail-closed），绝不提交。 */
function safeTest(
  test: ((original: Skill, patched: Skill) => boolean) | undefined,
  original: Skill,
  patched: Skill,
): boolean {
  if (test === undefined) return true;
  try {
    return test(original, patched) === true;
  } catch {
    return false;
  }
}

/** CRISPR 精确技能编辑器。 */
export class CRISPRSkillEditor implements CRISPRSkillEditorPort {
  /** 编辑面：技能的查询/替换都经此端口（通常是受种的 SkillRegistry）。 */
  private readonly port: SkillPort;
  /** 可选审计链：编辑应用/回滚事件入链，便于事后追溯。 */
  private readonly audit?: AuditSinkLike | undefined;
  /** 语义寻址共振阈值：共振度低于此值不命中（默认 0.5）。 */
  private readonly addressThreshold: number;
  /** 能力场维度（本征谱分箱数，须与燧-3 一致）。 */
  private readonly bins: number;
  /** 待批量执行的编辑队列（queue 入队、flush 消费）。 */
  private readonly queueBuf: CrisprEditSpec[] = [];
  /** 已成功应用（提交）的编辑计数。 */
  private applied = 0;

  public constructor(opts: CRISPRSkillEditorOptions) {
    this.port = opts.skillPort;
    this.audit = opts.audit;
    this.addressThreshold = opts.addressThreshold ?? 0.5;
    this.bins = opts.bins ?? 257;
  }

  /** 排入编辑队列（供主循环任务末批量 flush）。
   * @param spec 编辑规格（目标技能 + patch 函数 + 可选差异测试）。
   * @returns 无返回值。
   */
  public queue(spec: CrisprEditSpec): void {
    this.queueBuf.push(spec);
  }

  /** 批量执行队列；空队列返回空数组（主循环据此判断本阶段是否产出）。
   * @returns 逐条编辑产生的报告数组（按入队顺序）。
   */
  public flush(): readonly CrisprEditReport[] {
    const out: CrisprEditReport[] = [];
    while (this.queueBuf.length > 0) {
      const spec = this.queueBuf.shift()!;
      out.push(this.edit(spec));
    }
    return out;
  }

  /** 已成功应用（提交）的编辑数。
   * @returns 累计成功提交的编辑次数。
   */
  public appliedCount(): number {
    return this.applied;
  }

  /** 精确编辑一次：语义寻址 → 定点 patch → 差异测试（fail-closed 回滚）。
   * @param spec 编辑规格：目标（精确名或语义描述）、patch 函数与可选差异测试。
   * @returns 编辑报告：是否应用、命中技能名、是否语义寻址、是否回滚及原因。
   */
  public edit(spec: CrisprEditSpec): CrisprEditReport {
    // 1) 定位：精确名优先；否则语义寻址（skill-RNA 共振匹配）。
    const exact = this.port.get(spec.target);
    let target: Skill | undefined = exact;
    let semantic = false;
    if (target === undefined) {
      target = this.semanticLocate(spec.target);
      semantic = target !== undefined;
    }
    if (target === undefined) {
      return {
        applied: false,
        semanticAddress: false,
        rolledBack: false,
        reason: 'no-skill-matched',
      };
    }
    // 2) 定点 patch：仅改写 instructions。
    const patchedInstructions = spec.patch(target.instructions);
    if (patchedInstructions === target.instructions) {
      return {
        applied: false,
        skillName: target.name,
        semanticAddress: semantic,
        rolledBack: false,
        reason: 'no-op',
      };
    }
    const patched: Skill = {
      ...target,
      instructions: patchedInstructions,
      description: deriveDescription(target.description, patchedInstructions),
    };
    // 3) 差异测试（脱靶配）：fail-closed —— 不通过即回滚，绝不提交破损编辑。
    const passed = safeTest(spec.differentialTest, target, patched);
    if (!passed) {
      this.audit?.record({
        type: 'crispr',
        detail: {
          action: 'crispr.edit.rolledback',
          target: target.name,
          reason: 'differential-test-failed',
        },
      });
      return {
        applied: false,
        skillName: target.name,
        semanticAddress: semantic,
        rolledBack: true,
        reason: 'differential-test-failed',
      };
    }
    // 4) 提交：原地替换原技能（不新增训练成本）。
    this.port.replace(patched);
    this.applied++;
    this.audit?.record({
      type: 'crispr',
      detail: {
        action: 'crispr.edit.applied',
        target: target.name,
        mode: semantic ? 'semantic-address' : 'exact-name',
      },
    });
    return {
      applied: true,
      skillName: target.name,
      semanticAddress: semantic,
      rolledBack: false,
    };
  }

  /** 语义寻址：在技能池里取与目标描述共振最强者（严格高于阈值才命中）。
   * @param desc 目标技能的语义描述文本。
   * @returns 共振最强的技能；无技能超过阈值时为 undefined。
   */
  private semanticLocate(desc: string): Skill | undefined {
    const probe: Spectrum = eigenSpectrum(desc, this.bins);
    let best: Skill | undefined;
    let bestR = this.addressThreshold - 1e-9;
    for (const s of this.port.list()) {
      const r = resonance(probe, eigenSpectrum(s.instructions, this.bins));
      if (r > bestR) {
        bestR = r;
        best = s;
      }
    }
    return bestR >= this.addressThreshold ? best : undefined;
  }
}
