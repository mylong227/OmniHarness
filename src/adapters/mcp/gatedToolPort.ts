/**
 * 门禁工具端口（GatedToolPort）——给被包装的 ToolPort 的每次执行前置审批 + 沙箱门禁。
 *
 * 动机（A1 接线）：`mcp serve` 默认改走官方 SDK 适配器后，SDK 的 `registerTool` 回调直连
 * `ToolPort.execute`，会绕过既有手写 `McpServer` 里的 `ToolGate` 门禁——外部 MCP 客户端就能
 * 不经审批/沙箱直接驱动写文件、跑 shell。本适配器把门禁补回工具端口层：**任何经 SDK 到达
 * 工具集的调用都先过 `ToolGate`**，语义与手写实现逐字一致（拒绝时返回 ok:false + error）。
 */
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolPort,
  ToolResult,
} from '../../ports/tool/tool.js';

/**
 * 门禁的最窄结构契约（= `ToolGate.gate` 的形状）。
 *
 * 为什么不直接 import `src/core/toolGate`：架构门禁禁止 adapters→core 依赖
 * （`scripts/architectureGate.mjs` §2，白名单为空 = 新增即红）。适配器只需要「能裁决一次调用」
 * 这一条能力，按结构类型声明即可满足依赖倒置——宿主（CLI）传真实 `ToolGate`，适配器不反向依赖核心实现。
 */
export interface ToolGateLike {
  /**
   * 门禁裁决一次工具调用。
   * @param call 工具调用
   * @param sessionId 会话 id（规则可据此裁决）
   * @returns 拒绝时的 ToolResult；放行时 undefined
   */
  gate(call: ToolCall, sessionId: string): Promise<ToolResult | undefined>;
}

/**
 * 门禁工具端口：委托 `list`/`listDirect`/`unregister`，执行前先过门禁。
 */
export class GatedToolPort implements ToolPort {
  /** 适配器标识名（标明这是带门禁的包装层）。 */
  public readonly name: string;
  /** 内层工具端口（真实执行者）。 */
  private readonly inner: ToolPort;
  /** 审批 + 沙箱门禁（undefined = 不设门禁，等价直通）。 */
  private readonly gate: ToolGateLike | undefined;

  /**
   * @param inner 内层工具端口（工具清单与真实执行）
   * @param gate 门禁（缺省不设门禁）
   */
  public constructor(inner: ToolPort, gate?: ToolGateLike) {
    this.inner = inner;
    this.gate = gate;
    this.name = `${inner.name}+gated`;
  }

  /**
   * 工具清单（原样透传内层）。
   * @returns 工具定义只读数组
   */
  public list(): readonly ToolDefinition[] {
    return this.inner.list();
  }

  /**
   * 非延迟工具子集（原样透传；内层未实现时由 ToolPort 消费方回退 list）。
   * @returns 工具定义只读数组
   */
  public listDirect(): readonly ToolDefinition[] {
    return this.inner.listDirect === undefined ? this.inner.list() : this.inner.listDirect();
  }

  /**
   * 反注册工具（原样透传；内层不支持时返回 false）。
   * @param name 工具名
   * @returns 内层是否真的移除
   */
  public unregister(name: string): boolean {
    return this.inner.unregister === undefined ? false : this.inner.unregister(name);
  }

  /**
   * 执行工具：先过门禁（拒绝即回 ok:false，不触达真实工具），再委托内层执行。
   * @param call 工具调用
   * @param context 工具上下文（会话 id 供门禁裁决）
   * @returns 工具执行结果（门禁拒绝或内层执行结果）
   */
  public async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const denied =
      this.gate === undefined ? undefined : await this.gate.gate(call, context.sessionId);
    if (denied !== undefined) {
      return denied;
    }
    return this.inner.execute(call, context);
  }
}
