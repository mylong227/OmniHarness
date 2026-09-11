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
import type { SkillPort } from '../../ports/skill.js';
import { eigenSpectrum, resonance, type Spectrum } from '../../util/eigenSpectrum.js';
import type { AuditSinkLike } from '../../ports/supervisor.js';
import type {
  CRISPRSkillEditorPort,
  CrisprEditReport,
  CrisprEditSpec,
} from '../../ports/skillEdit.js';

/** CRISPRSkillEditor 选项。 */
export interface CRISPRSkillEditorOptions {
  /** 编辑面（通常是受种的 SkillRegistry）。 */
  readonly skillPort: SkillPort;
  /** 可选审计链：编辑/回滚事件入链（与免疫监控同机制）。 */
  readonly audit?: AuditSinkLike;
  /** 语义寻址共振阈值（默认 0.5）。 */
  readonly addressThreshold?: number;
  /** 能力场维度（默认 257，须与燧-3 一致）。 */
  readonly bins?: number;
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
  private readonly port: SkillPort;
  private readonly audit?: AuditSinkLike;
  private readonly addressThreshold: number;
  private readonly bins: number;
  private readonly queueBuf: CrisprEditSpec[] = [];
  private applied = 0;

  public constructor(opts: CRISPRSkillEditorOptions) {
    this.port = opts.skillPort;
    this.audit = opts.audit;
    this.addressThreshold = opts.addressThreshold ?? 0.5;
    this.bins = opts.bins ?? 257;
  }

  /** 排入编辑队列（供主循环任务末批量 flush）。 */
  public queue(spec: CrisprEditSpec): void {
    this.queueBuf.push(spec);
  }

  /** 批量执行队列；空队列返回空数组（主循环据此判断本阶段是否产出）。 */
  public flush(): readonly CrisprEditReport[] {
    const out: CrisprEditReport[] = [];
    while (this.queueBuf.length > 0) {
      const spec = this.queueBuf.shift()!;
      out.push(this.edit(spec));
    }
    return out;
  }

  /** 已成功应用（提交）的编辑数。 */
  public appliedCount(): number {
    return this.applied;
  }

  /** 精确编辑一次：语义寻址 → 定点 patch → 差异测试（fail-closed 回滚）。 */
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
        action: 'crispr.edit.rolledback',
        target: target.name,
        detail: 'differential-test-failed',
      } as unknown as Parameters<AuditSinkLike['record']>[0]);
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
      action: 'crispr.edit.applied',
      target: target.name,
      detail: semantic ? 'semantic-address' : 'exact-name',
    } as unknown as Parameters<AuditSinkLike['record']>[0]);
    return {
      applied: true,
      skillName: target.name,
      semanticAddress: semantic,
      rolledBack: false,
    };
  }

  /** 语义寻址：在技能池里取与目标描述共振最强者（严格高于阈值才命中）。 */
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
