import type { RouterEntry } from './routerEntry.ts';
import type { RouterStrategy } from './routerStrategy.ts';

/** ModelRouter 构造参数。 */
export interface ModelRouterOptions {
  /** 候选底层模型列表（至少一项，空则构造即抛错）。 */
  readonly entries: readonly RouterEntry[];
  /** 路由策略：最低成本 / 轮询 / 按任务关键词 / 按上下文 / 按角色 / 健康度降级。 */
  readonly strategy: RouterStrategy;
  /** by-task 策略下，仅在该 role 的消息中匹配关键词（缺省匹配全部消息）。 */
  readonly taskField?: string | undefined;
  /** by-role 策略：角色 → 模型名；未映射的角色回退第一个 entry。 */
  readonly roles?: Readonly<Record<string, string>> | undefined;
}
