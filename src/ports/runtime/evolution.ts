/**
 * 进化闭环端口（Evolvix 核心 / P1 首发块）。
 *
 * 把"经验 → 发现(DiscoveryEngine) → 评估(EvolutionGate) → 晋升"串成
 * fail-closed 的进化门禁：任何候选能力都必须过「真实基准评估 + 安全检查」才晋升，
 * 默认拒绝。这是 13_方案代码对账 判定的"决定性短板"——OmniHarness 此前完全没有
 * "把实验产出变成可复用、可评估、可晋升能力"的闭环管线。
 *
 * 本端口无第三方依赖、零运行时负担：DiscoveryEngine 受 discoveryBudget 硬上限约束，
 * EvolutionGate 默认拒绝（fail-closed），晋升动作由调用方注入（如注册进 SkillRegistry）。
 *
 * @beta 属 P1 内核升级子系统，接口仍可能微调。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./evolution/`，调用点零改动。
 */

export type { Candidate } from './evolution/candidate.js';
export type { PromotionVerdict } from './evolution/promotionVerdict.js';
export type { EvolutionGate } from './evolution/evolutionGate.js';
export type { DiscoveryEngine } from './evolution/discoveryEngine.js';
export type { EvolutionControllerOptions } from './evolution/evolutionControllerOptions.js';
export type { EvolutionController } from './evolution/evolutionController.js';
