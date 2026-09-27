/**
 * 回合**完成闸门**端口（2026-09-26 审计 A1；2026-09-27 从 `core/turnRunner` 下沉）。
 *
 * 为什么需要它：自验证回环此前只是**信号**（把失败摘要追加进工具结果），模型完全可以无视它
 * 直接输出结论收尾 —— 产品路径上没有任何东西阻止「改坏了代码还宣布完成」。
 * 本接口把「本会话最近一次对源码改动的验证结果」暴露给 `TurnRunner`：仍有失败则回灌并再给一步。
 *
 * 两种实现（`kind` 决定触发条件）：
 *  - `'status'`：读写时自验证的**已有结论**（零额外开销，任何时机都可问）；
 *  - `'turn-end'`：在回合末尾**现跑一次**验证命令（因此只在「本回合确实改过文件」时才问，
 *    否则纯问答回合也会平白跑一次测试）。
 *
 * **为何在 ports 而非 core**：合同类型原先声明在 `core/turnRunner.ts`，于是选实现的适配器
 * （`adapters/tool/verify/turnCompletionGateFactory`）必须 import core 具体模块、组合根又必须
 * 让 core 反向 import 适配器——一次接线踩出两条 `adapters→core` / `core→adapters` 架构违规。
 * 契约下沉到端口后，core 只依赖端口、适配器实现端口、组合根（`composition/`）注入，方向向内。
 *
 * 端口纯度：本文件只有接口与类型别名（无 class、无第三方裸导入）。
 */
import type { ToolPort } from '../tool/tool.js';

/** 回合完成闸门契约。 */
export interface CompletionGate {
  /** 闸门种类：决定「是否需要本回合改过文件」这一前置条件。 */
  readonly kind: 'status' | 'turn-end';
  /**
   * 核验本会话最近一次对源码改动的验证结果。
   * @param sessionId 会话 id。
   * @returns 失败摘要；验证通过、未验证或无法验证时为 undefined。
   */
  verify(sessionId: string): Promise<string | undefined>;
}

/**
 * 装配闸门所需的最小运行期事实（只有这三项，端口不绑死 `ResolvedConfig`）。
 * `selfVerify` 按**结构**声明：只列闸门真正消费的字段，故 `SelfVerifyConfig` 等具体配置类型可原样传入。
 */
export interface CompletionGateContext {
  /** 已装配的工具端口：写时自验证实现会把自己的最近结论挂在上面。 */
  readonly tools: ToolPort;
  /** 用户显式写下的自验证声明（缺省 undefined＝未启用；`enabled:false`＝显式退出）。 */
  readonly selfVerify?: CompletionGateSelfVerifyConfig | undefined;
  /** 工作区根：用于探测「本仓库有没有可跑的验证命令」。 */
  readonly workspaceRoot: string;
}

/** 闸门消费的自验证声明字段（结构子集，避免端口绑死配置实现）。 */
export interface CompletionGateSelfVerifyConfig {
  /** 是否启用写时自验证；显式 `false` 视为「验证」的整体退出。 */
  readonly enabled?: boolean | undefined;
  /** 显式测试命令（缺省由工作区证据推断）。 */
  readonly command?: string | undefined;
  /** 单次验证超时（毫秒）。 */
  readonly timeoutMs?: number | undefined;
  /** 回灌摘要的输出字节上限。 */
  readonly maxOutputBytes?: number | undefined;
  /** 回灌摘要的最大行数。 */
  readonly maxDigestLines?: number | undefined;
}

/**
 * 闸门工厂端口：由组合根注入实现，core 只调用不实现。
 * @param context 装配闸门所需的运行期事实。
 * @returns 选中的闸门；无可用闸门（显式退出 / 探测不到命令）时为 undefined。
 */
export type CompletionGateFactory = (context: CompletionGateContext) => CompletionGate | undefined;
