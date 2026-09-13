import { SkillRegistry } from '../skill/skillRegistry.js';
import { CRISPRSkillEditor } from '../adapters/skill/crisprSkillEditor.js';
import { CapabilityCrystallizer } from '../adapters/skill/capabilityCrystallizer.js';
import { InsightEtchingEngine } from '../adapters/memory/insightEtchingEngine.js';
import { ElementComposer } from '../adapters/skill/elementComposer.js';
import { SymmetryBreakingEngine } from '../adapters/monitoring/symmetryBreakingEngine.js';
import { ConfinementEngine } from '../adapters/monitoring/confinementEngine.js';

import type { OmniHarnessConfig } from './configFactory.js';

/**
 * 技能 / 能力算子栈切片：直接并入 `ResolvedConfig` 的字段子集。
 * 全部围绕「受种技能池」这一单一状态源展开——编辑器、固化器与各型能力算子共用同一注册表。
 */
export interface SkillStack {
  /** 受种技能注册表：CRISPR 编辑面 / 相变固化组合解析面；亦可注入 Agent 增强技能匹配。 */
  readonly skillRegistry: SkillRegistry;
  /** (P2, I-P2-4) CRISPR 精确技能编辑器（可选）：`skillEditing.enabled` 时构造。 */
  readonly crispr: CRISPRSkillEditor | undefined;
  /** (P2, I-P2-5) 相变固化器（可选）：`capabilityCrystallization.enabled` 时构造。 */
  readonly crystallizer: CapabilityCrystallizer | undefined;
  /** (P3, I-P3-1) 刻蚀记忆引擎（可选）：`insightEtching.enabled` 时构造。 */
  readonly etching: InsightEtchingEngine | undefined;
  /** (P3, I-P3-2) 元素组合基元引擎（可选）：`elementComposer.enabled` 时构造。 */
  readonly elementComposerEngine: ElementComposer | undefined;
  /** (P3, I-P3-3) 对称破缺引擎（可选）：`symmetryBreaking.enabled` 时构造。 */
  readonly symmetry: SymmetryBreakingEngine | undefined;
  /** (P3, I-P3-4) 禁闭色荷引擎（可选）：`confinement.enabled` 时构造。 */
  readonly confinementEngine: ConfinementEngine | undefined;
}

/**
 * 装配技能 / 能力算子栈（组合根一侧）。
 *
 * 先由配置技能池构造 `SkillRegistry`（空池亦安全），再把编辑器 / 固化器 / 各型能力算子
 * 依次挂到同一注册表上——保证「编辑—固化—观测」面对的是同一份技能状态，不产生影子副本。
 * 各算子均为 opt-in：未显式启用即 undefined，主循环零侵入。
 *
 * @param partial 未解析的运行配置。
 * @returns 技能栈切片（技能注册表恒存在，其余算子按开关可选）。
 */
export function assembleSkillStack(partial: OmniHarnessConfig): SkillStack {
  // 受种技能注册表：从配置技能池构造，供 CRISPR 编辑与相变固化复用（零破坏：空池亦安全）。
  const skillRegistry = new SkillRegistry();
  if (partial.skills !== undefined) {
    for (const skill of partial.skills) skillRegistry.register(skill);
  }
  return {
    skillRegistry,
    crispr: buildCrispr(partial, skillRegistry),
    crystallizer: buildCrystallizer(partial, skillRegistry),
    etching: buildEtching(partial),
    elementComposerEngine:
      partial.elementComposer?.enabled === true ? new ElementComposer() : undefined,
    symmetry: buildSymmetry(partial),
    confinementEngine: buildConfinement(partial),
  };
}

/** (P2, I-P2-4) CRISPR 精确技能编辑：启用时构造编辑器（接受种技能端口）。 */
function buildCrispr(
  partial: OmniHarnessConfig,
  skillPort: SkillRegistry,
): CRISPRSkillEditor | undefined {
  if (partial.skillEditing?.enabled !== true) {
    return undefined;
  }
  return new CRISPRSkillEditor({
    skillPort,
    addressThreshold: partial.skillEditing.addressThreshold,
    bins: partial.skillEditing.bins,
  });
}

/** (P2, I-P2-5) 相变固化：启用时构造固化器（接受种技能端口）。 */
function buildCrystallizer(
  partial: OmniHarnessConfig,
  skillPort: SkillRegistry,
): CapabilityCrystallizer | undefined {
  if (partial.capabilityCrystallization?.enabled !== true) {
    return undefined;
  }
  return new CapabilityCrystallizer({
    skillPort,
    densityThreshold: partial.capabilityCrystallization.densityThreshold,
    decay: partial.capabilityCrystallization.decay,
    fieldSize: partial.capabilityCrystallization.fieldSize,
    resetOnCrystallize: partial.capabilityCrystallization.resetOnCrystallize,
  });
}

/** (P3, I-P3-1) 刻蚀记忆：启用时构造引擎（分形分支树刻蚀 + 低阻导通）。 */
function buildEtching(partial: OmniHarnessConfig): InsightEtchingEngine | undefined {
  if (partial.insightEtching?.enabled !== true) {
    return undefined;
  }
  return new InsightEtchingEngine({
    resonanceThreshold: partial.insightEtching.resonanceThreshold,
  });
}

/** (P3, I-P3-3) 对称破缺算子：启用时构造有序参量 ρ 的相变可观测引擎。 */
function buildSymmetry(partial: OmniHarnessConfig): SymmetryBreakingEngine | undefined {
  if (partial.symmetryBreaking?.enabled !== true) {
    return undefined;
  }
  return new SymmetryBreakingEngine({ threshold: partial.symmetryBreaking.threshold });
}

/** (P3, I-P3-4) 禁闭色荷端口：启用时构造多维色荷张量收缩引擎。 */
function buildConfinement(partial: OmniHarnessConfig): ConfinementEngine | undefined {
  if (partial.confinement?.enabled !== true) {
    return undefined;
  }
  return new ConfinementEngine({ groupOrder: partial.confinement.groupOrder });
}
