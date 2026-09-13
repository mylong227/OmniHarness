/**
 * CRISPR 精确技能编辑端口（P2, I-P2-4）。
 *
 * 基因工程隐喻：用 `skill-RNA` 语义寻址定位技能片段，做定点 patch（而非重训整个模型），
 * 再以"差异测试 + 回滚"防脱靶（fail-closed）。编辑只改写既有技能、不新增训练成本。
 *
 * 语义寻址复用燧-3 频率域共振代数（eigenSpectrum/resonance）——把目标描述与每个技能
 * instructions 的本征谱比对，取共振最强者（精确名优先于语义匹配）。
 */
import type { Skill } from '../../skill/skill.js';

/** CRISPR 编辑规格。 */
export interface CrisprEditSpec {
  /**
   * 目标技能：精确名称优先命中；非精确名（或仅给语义描述）时按共振做语义寻址，
   * 取最相似技能。两者皆无命中则报告 no-skill-matched（不报错、零破坏）。
   */
  readonly target: string;
  /** 定点改写：输入原 instructions，返回改写后文本。仅作用于该字段（描述同步派生，避免契约漂移）。 */
  readonly patch: (instructions: string) => string;
  /**
   * 差异测试（脱靶配）：对改写前后两版技能对比，返回 true 表示可安全接受。
   * 这是 fail-closed 防脱靶的核心——不传则默认接受（谨慎：生产环境务必提供）。
   */
  readonly differentialTest?: (original: Skill, patched: Skill) => boolean;
  /** 语义寻址共振阈值（默认 0.5）：低于此不视为命中，回退到精确名。 */
  readonly addressThreshold?: number;
}

/** CRISPR 单次编辑报告（可审计）。 */
export interface CrisprEditReport {
  /** 是否真正提交（patch 通过差异测试并写回端口）。 */
  readonly applied: boolean;
  /** 命中的技能名（语义寻址时为最相似者）。 */
  readonly skillName?: string;
  /** 是否经语义寻址命中（而非精确名）。 */
  readonly semanticAddress: boolean;
  /** 是否因差异测试失败而回滚（fail-closed，绝不提交破损编辑）。 */
  readonly rolledBack: boolean;
  /** 失败/跳过原因：no-skill-matched | no-op | differential-test-failed。 */
  readonly reason?: string;
}

/** CRISPR 精确技能编辑器端口。 */
export interface CRISPRSkillEditorPort {
  /** 精确编辑一次：语义寻址定位 → 定点 patch → 差异测试（fail-closed 回滚）。 */
  edit(spec: CrisprEditSpec): CrisprEditReport;
  /** 排入编辑队列（供主循环任务末批量 flush）。 */
  queue(spec: CrisprEditSpec): void;
  /** 批量执行队列（主循环用）；空队列返回空数组。 */
  flush(): readonly CrisprEditReport[];
  /** 已成功应用（提交）的编辑数。 */
  appliedCount(): number;
}
