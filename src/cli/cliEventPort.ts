import { ConsoleEventPort } from '../adapters/event/consoleEventPort.js';
import { SilentEventPort } from '../adapters/event/silentEventPort.js';
import { CompositeEventPort } from '../adapters/event/compositeEventPort.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { CliArgs } from './argParser.js';

/**
 * `--events` 到事件端口的解析（+ 调用方注入的**追加出口**）。
 *
 * 独立成类而不是留在 `CliBuildConfig`：那个类已贴「上帝类」体量闸（`check.mjs` 的
 * 编码标准增量门禁会拦新增违规），按本仓惯例**按职责搬出**（同族先例：`CliSkillFlags.resolve` /
 * `CliDecisionEngineFlags.resolve` / `CliSubsystemSections.of`），而不是放宽阈值。
 *
 * 为什么要 `extra`：serve 的事件出口是**客户端实时流**，而工具侧的事件端口在
 * `ConfigFactory.build` 期就被工具捕获（`AskUserTool` / `TodoWriteTool` / `PlanWriteTool`）。
 * 不注入它，serve 里这些工具发出的事件（`question` / `todo` / `plan`）只会走控制台或被丢弃
 * ——**客户端收不到**。2026-10-08 用户报障截图里「提问」那一块，实际只在**切换过工作区之后**
 * 才偶然出现（`switchWorkspace` 重建配置时顺手换成了服务端端口），正是这条接线缺失的表现。
 */
export class CliEventPort {
  /**
   * 解析生效的事件端口。
   *
   * 组合语义（**不是二选一**）：`--events console`（**也是缺省**）时控制台与追加出口**并存**
   * （控制台可读 + 客户端实时流）；`--events silent` 时静默占位被追加出口**替换**——静默端口
   * 只是「不要控制台输出」的占位，并联它毫无意义。
   * @param args 解析后的 CLI 参数（读 `args.events`）。
   * @param extra 追加出口（serve 的事件桥；缺省表示没有额外出口）。
   * @returns 生效的事件端口。
   */
  public static of(args: CliArgs, extra?: EventPort): EventPort {
    const consolePort = args.events === 'console' ? new ConsoleEventPort() : undefined;
    if (extra === undefined) {
      return consolePort ?? new SilentEventPort();
    }
    return consolePort === undefined ? extra : new CompositeEventPort([consolePort, extra]);
  }
}
