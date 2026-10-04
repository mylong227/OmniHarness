import type { ToolDefinition } from './tool.js';

/**
 * 工具发现寄存器端口（G25 收尾，2026-10-04 第三十轮）。
 *
 * 原 `CorePorts.discovery` / `ResolvedConfig.discovery` / `OmniHarnessRuntime.discovery` 绑定在
 * search 层实现类 `ToolDiscovery` 上——端口契约被绑死在具体类型，构成 ports→search 的隐性实现
 * 依赖（门禁 [3.5] 当时只覆盖 core/adapters/config/composition，`context/`/`search/` 是漏网层）。
 * 抽到端口后，`ports/config/**`、`ports/composition/**`、`core/stepTypes` 仅依赖本接口；
 * 实现类 `ToolDiscovery` `implements` 本接口，实例仍由组合根装配。
 *
 * 与 {@link ToolDefinition} 的延迟加载闭环（#M1）：被标记 `deferred` 的工具仍注册在 registry、
 * 仍可 `execute`，只是不出现在 `listDirect()`（模型上下文）；经 `tool_search` 发现后其 schema
 * 进入本寄存器，下一回合对模型可见，从而可发起调用。
 */
export interface ToolDiscoveryPort {
  /**
   * 登记一批工具 schema（按名去重，后者覆盖前者）。
   * @param specs 命中的工具定义（`tool_search` 的检索结果）。
   * @returns 无返回值。
   */
  add(specs: readonly ToolDefinition[]): void;

  /**
   * 已发现的工具 schema 列表（登记序）。
   * @returns 工具定义快照。
   */
  list(): readonly ToolDefinition[];

  /**
   * 是否已发现某工具。
   * @param name 工具名。
   * @returns 已发现为 true。
   */
  has(name: string): boolean;
}
