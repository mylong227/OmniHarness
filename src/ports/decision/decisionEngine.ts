/**
 * 决策引擎端口（System-1 类型化判断）：用单次前向的类型化决策，替代 LLM 长推理做
 * 高频结构化判断点（参考 Laya 的 `choice` / `score` / `noul` 原语）。
 *
 * 设计取向（六边形）：本文件属 `ports/**`，**第三方-free**，不依赖任何推理实现；
 * 具体推理（本地 Python `laya` 包 / onnxruntime / 远程）由 `adapters/**` 承载。
 *
 * fail-open 铁律：任何实现都不得在不可用时抛错阻断主流程——`decide` 须返回
 * `available:false`，让调用方回落到原有 LLM 路径。这与本仓低频安全边界（护栏
 * fail-closed）取向不同：决策引擎是「质量 / 成本信号」，不是安全边界。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./decisionEngine/`，调用点零改动。
 */

export type { DecisionKind } from './decisionEngine/decisionKind.js';
export type { DecisionQuestion } from './decisionEngine/decisionQuestion.js';
export type { DecisionAnswer } from './decisionEngine/decisionAnswer.js';
export type { DecisionRequest } from './decisionEngine/decisionRequest.js';
export type { DecisionResponse } from './decisionEngine/decisionResponse.js';
export type { DecisionEngine } from './decisionEngine/decisionEngine.js';
