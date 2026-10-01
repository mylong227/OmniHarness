import type { AgentPort } from './agentPort.js';

/**
 * Agent 工厂端口：组合根（config/）注入，按运行时构造 {@link AgentPort} 实例。
 * 解耦 adapters→core——run_goal 工具经本端口取得 Agent，不直接 new core 具体实现。
 *
 * **为什么运行时是类型参数**（2026-09-22 修，审计 P1-4）：本端口此前直接 import 了
 * `OmniHarnessRuntime`（来自 core 的运行时实现模块），把端口契约绑死在一个**具体实现类型**上——
 * 「ports 只依赖契约」在类型层被破坏，且架构门禁看不见（它原先只判 core↔adapters）。
 * 改为泛型参数后，端口自身只声明「存在某个运行时形状」，由实现方（`config/agentFactory.ts`）
 * 绑定具体类型；消费方（`runGoalTool`）用缺省参数即可。
 * 类型参数缺省 `unknown`：方法参数位置是双变的（strictFunctionTypes 下方法签名仍双变），
 * 故「接受具体运行时的实现」可安全赋给「接受 unknown 的端口」，无需任何类型逃逸。
 * @typeParam TRuntime 运行时形状（实现方绑定具体类型；消费方缺省 unknown）
 */
export interface AgentFactoryPort<TRuntime = unknown> {
  /**
   * 构造一个 Agent 实例。
   * @param runtime 子智能体运行时。
   * @returns Agent 端口实现。
   */
  create(runtime: TRuntime): AgentPort;
}
