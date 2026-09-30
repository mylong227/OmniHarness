/**
 * I-P3-2 元素组合基元（Periodic Table Primitives）端口。
 *
 * 真原创计算原语（燧-核·元素周期表）：用**有限基元集**（元素周期表）组合出多样能力。
 * 每个元素有化学价(valence)，组合合法 = 价互补(valence 相加为 0)，否则 fail-closed 拒绝。
 * 表达力远超"硬编码能力清单"——能力是**组合代数**的产物，有限基元涌现无限组合。
 *
 * fail-closed：未知元素 → 抛错（配置错误）；价不互补 → 返回 undefined（组合不合法）。
 */

export type { ElementDef } from './elementComposer/elementDef.js';
export type { CompoundCapability } from './elementComposer/compoundCapability.js';
export type { ElementComposerPort } from './elementComposer/elementComposerPort.js';
