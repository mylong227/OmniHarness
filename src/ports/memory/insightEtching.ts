/**
 * I-P3-1 利希滕贝格刻蚀记忆（Lichtenberg Insight Etching）端口。
 *
 * 真原创计算原语（燧-7）：一次"顿悟/重大事件"不在内存追加一条，而是在记忆介质上
 * **刻出分支决策树（分形 trace）**；后续同类推理可沿刻痕**低阻导通**。顿悟=放电刻蚀。
 * 这是现有系统（增量权重 / 记忆追加）没有的"事件在结构上刻痕、之后沿痕导通"的信息操作。
 *
 * fail-closed：空事件 / 空分支抛错；无共振(全 < 阈值)的查询 → conduct 返回 []。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./insightEtching/`，调用点零改动。
 */

export type { EtchBranch } from './insightEtching/etchBranch.js';
export type { EtchEvent } from './insightEtching/etchEvent.js';
export type { EtchNode } from './insightEtching/etchNode.js';
export type { EtchTrace } from './insightEtching/etchTrace.js';
export type { EtchConduction } from './insightEtching/etchConduction.js';
export type { InsightEtchingPort } from './insightEtching/insightEtchingPort.js';
