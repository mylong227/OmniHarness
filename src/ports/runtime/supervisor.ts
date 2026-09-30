/**
 * 航天级监督内核端口（I-P0-3 / FDIR）。
 *
 * 把 NASA 风格的 Fault Detection, Isolation, Recovery 收敛为一个确定性状态机：
 * 监控工具执行健康度 → 失败率超阈分级降级 → 危险动作零越权 → 优雅恢复。
 * 本端口是「ML 层之上的确定性否决」，优先级高于 Approval/Sandbox——任何它判为
 * 危险的动作在 ToolGate 最前被拦下，审批/沙箱放行也无效。
 *
 * @beta 属 P0 内核升级子系统，接口仍可能微调。
 *
 * 本文件已退化为桶：6 个接口各自独立成文件于 `./supervisor/`，调用点零改动。
 */

export type { SafeMode } from './supervisor/safeMode.js';
export type { HealthEntry } from './supervisor/healthEntry.js';
export type { HealthSnapshot } from './supervisor/healthSnapshot.js';
export type { AuditSinkLike } from './supervisor/auditSinkLike.js';
export type { SupervisorOptions } from './supervisor/supervisorOptions.js';
export type { SupervisorPort } from './supervisor/supervisorPort.js';
