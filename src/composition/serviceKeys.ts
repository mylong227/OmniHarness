/**
 * 端口服务键（容器内标准键名）——**独立模块以打断组合根 ↔ 子代理的真值环**。
 *
 * 为什么单列（2026-09-22 修，审计 P1-4）：`ServiceKeys` 原先定义在运行时装配模块里
 * （原 `src/core/runtime.ts`，现 `src/composition/runtime.ts`），而该模块又值导入
 * `subagent/subagentRuntimeFactory.ts` 去装配子代运行时 ⇒ 形成
 * 「组合根 → 子代理工厂 → 组合根」的真值双向环。把这份**纯常量表**下沉到独立模块后，
 * 子代理工厂只依赖本模块，环被切断，装配模块回到单向依赖。
 *
 * 本模块**不依赖任何运行时代码**（只有字符串常量），因此可被任意层安全引用。
 */
export const ServiceKeys = {
  model: 'port.model',
  tools: 'port.tools',
  storage: 'port.storage',
  events: 'port.events',
  sandbox: 'port.sandbox',
  approvals: 'port.approvals',
} as const;
