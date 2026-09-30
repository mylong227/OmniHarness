import type { ToolPort } from '../tool/tool.js';
import type { CompletionGateSelfVerifyConfig } from './completionGateSelfVerifyConfig.js';

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
