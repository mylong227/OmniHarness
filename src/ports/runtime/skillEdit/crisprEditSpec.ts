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
