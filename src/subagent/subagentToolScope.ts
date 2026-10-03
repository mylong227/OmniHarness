import { MUTATING_TOOLS } from '../core/toolGate.js';
import type { SubagentRequest } from './subagentTypes.js';

/**
 * @beta
 * 子智能体**工具面收窄**的判定类（2026-10-03 第六轮修看板 §8.1）。
 *
 * 存在理由：子代理的文件写入落在隔离工作树里，而清理是 `git worktree remove --force` + `git branch -D`。
 * 在 **copy 降级档**（git 不可用/失败）下**没有 git 可比** ⇒ 改动连 patch 都取不回来，只能丢。
 * 该档的唯一不制造"静默丢失"的做法就是**禁写**（fail-closed）：与其让子代理改完再无声丢弃，
 * 不如让它明确说"我改不了代码"，由主会话执行。
 *
 * 与 `a2aTaskExecutor` 委托给对等方时的做法同源（那里同样剔除 {@link MUTATING_TOOLS} 收窄能力面）。
 */
export class SubagentToolScope {
  /**
   * 生成"写类工具已被禁用"的请求：`tools` 显式给出「除写类之外的全部工具」。
   *
   * 为什么必须显式展开而不是留空：`SubagentRunner.toolViewOf` 把**缺省的 `tools`** 解释为
   * "给我工具全集"——留空等于把写类工具又放回来。
   * @param request 原始子任务请求。
   * @param available 当前可用的工具名全集（通常来自 `ports.tools.list()`）。
   * @returns 收窄后的请求（新对象，不改原请求）。
   */
  public static writeForbidden(
    request: SubagentRequest,
    available: readonly string[],
  ): SubagentRequest {
    const base = request.tools ?? available;
    return { ...request, tools: base.filter((name) => !MUTATING_TOOLS.has(name)) };
  }

  /**
   * 该请求在收窄后是否**真的**拿不到写类工具（自检用：确保收窄没有漏网）。
   * @param request 收窄后的请求。
   * @returns 不含任何写类工具时为 true。
   */
  public static hasNoWriters(request: SubagentRequest): boolean {
    return (request.tools ?? []).every((name) => !MUTATING_TOOLS.has(name));
  }
}
