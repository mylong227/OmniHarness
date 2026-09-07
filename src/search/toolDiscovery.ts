import type { ToolDefinition } from '../ports/tool.js';

/**
 * @beta
 * 工具发现寄存器（#M1）：`tool_search` 命中的工具 schema 登记于此，
 * StepRunner 在后续回合把它们并入模型可见工具集，使「延迟加载」工具可被真正调用。
 *
 * 与 RegistryToolPort 的关系是：被标记为 `deferred` 的工具仍注册在 registry 中、
 * 仍可 `execute`，只是默认不出现在 `listDirect()`（即模型上下文）。经 `tool_search`
 * 发现后，其 schema 进入本寄存器，下一回合即对模型可见，从而可发起调用。
 */
export class ToolDiscovery {
  private readonly discovered = new Map<string, ToolDefinition>();

  /** 登记一批工具 schema（按名去重，后者覆盖前者）。 */
  add(specs: readonly ToolDefinition[]): void {
    for (const spec of specs) {
      this.discovered.set(spec.name, spec);
    }
  }

  /** 已发现的工具 schema 列表。 */
  list(): readonly ToolDefinition[] {
    return [...this.discovered.values()];
  }

  /** 是否已发现某工具。 */
  has(name: string): boolean {
    return this.discovered.has(name);
  }
}
