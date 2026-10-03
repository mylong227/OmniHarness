import { ServiceKey } from '../core/serviceKey.js';
import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { ModelPort } from '../ports/model/model.js';
import type { ToolPort } from '../ports/tool/tool.js';
import type { StoragePort } from '../ports/memory/storage.js';

/**
 * 端口服务键（容器内标准键）——**独立模块以打断组合根 ↔ 子代理的真值环**。
 *
 * 为什么单列（2026-09-22 修，审计 P1-4）：`ServiceKeys` 原先定义在运行时装配模块里
 * （原 `src/core/runtime.ts`，现 `src/composition/runtime.ts`），而该模块又值导入
 * `subagent/subagentRuntimeFactory.ts` 去装配子代运行时 ⇒ 形成
 * 「组合根 → 子代理工厂 → 组合根」的真值双向环。把这份**纯常量表**下沉到独立模块后，
 * 子代理工厂只依赖本模块，环被切断，装配模块回到单向依赖。
 *
 * 本模块**不依赖任何运行时代码**（只有类型与令牌常量），因此可被任意层安全引用。
 *
 * ## 从"字符串常量"升级为"泛型令牌"（G26/TS2，2026-10-03 第十三轮）
 *
 * 原先是 `{ model: 'port.model', ... } as const`——键与值类型在类型层毫无关联，
 * `container.register(ServiceKeys.tools, 某个 ModelPort)` 这种**串键**编译期抓不到。
 * 现在每个键是 `ServiceKey<对应端口类型>`：
 *  - 注册时 `instance` 必须匹配该端口 ⇒ **类型不符即编译失败**；
 *  - 取用时 `container.get(ServiceKeys.tools)` 直接推出 `ToolPort`，**无需显式泛型参数与断言**。
 *
 * **兼容性**：所有既有调用点都是"把 `ServiceKeys.x` 传给 `register`"，形态不变、零改动；
 * 仅当外部代码把该值**当作字符串**使用（拼日志/做 Map 键）时才会收到编译错误——那正是希望它发生的地方
 * （令牌有 `name` 与 `toString()`，改写成本极低）。容器仍保留字符串键重载，第三方扩展不受影响。
 */
export const ServiceKeys = {
  model: new ServiceKey<ModelPort>('port.model'),
  tools: new ServiceKey<ToolPort>('port.tools'),
  storage: new ServiceKey<StoragePort>('port.storage'),
  events: new ServiceKey<EventPort>('port.events'),
  sandbox: new ServiceKey<SandboxPort>('port.sandbox'),
  approvals: new ServiceKey<ApprovalPort>('port.approvals'),
} as const;
