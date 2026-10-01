/**
 * 决策 trace 端口（Laya 战略线 · 校准/评估数据面）：把「System-1 预判 vs 真实结果」配对样本
 * 交给实现落盘，供离线 RLCD 温度校准与借鉴清单项（§34.7 ②③：模型路由 / 相关度裁剪 / 全工具选择）
 * 的训练使用。
 *
 * 六边形（ports 第三方-free）：仅定义记录契约，落盘 / 上报由 `adapters/**` 承载。
 *
 * fail-open 铁律：写入实现**不得**抛错阻断主流程——`record` 的异常由实现内部吞掉
 * （与决策引擎「质量信号非安全边界」取向一致）。
 */

export type { DecisionTrace } from './decisionTrace/decisionTrace.js';
export type { DecisionTracePort } from './decisionTrace/decisionTracePort.js';
