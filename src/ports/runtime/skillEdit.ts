/**
 * CRISPR 精确技能编辑端口（P2, I-P2-4）。
 *
 * 基因工程隐喻：用 `skill-RNA` 语义寻址定位技能片段，做定点 patch（而非重训整个模型），
 * 再以"差异测试 + 回滚"防脱靶（fail-closed）。编辑只改写既有技能、不新增训练成本。
 *
 * 语义寻址复用燧-3 频率域共振代数（eigenSpectrum/resonance）——把目标描述与每个技能
 * instructions 的本征谱比对，取共振最强者（精确名优先于语义匹配）。
 */

export type { CrisprEditSpec } from './skillEdit/crisprEditSpec.js';
export type { CrisprEditReport } from './skillEdit/crisprEditReport.js';
export type { CRISPRSkillEditorPort } from './skillEdit/crisprSkillEditorPort.js';
