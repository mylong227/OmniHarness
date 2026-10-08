import type { SessionEvent } from '../../ports/runtime/event.js';
import type { EventPort } from '../../ports/runtime/eventPort.js';
import { log } from '../../util/logger.js';

/**
 * 事件端口**扇出**：同一条会话事件按序送给多个出口。
 *
 * 存在理由（2026-10-08）：serve 的「事件出口」有两个互不替代的用途——**客户端实时流**
 * （Web UI 的 `thread.event`）与**控制台可读输出**（`--events console`）。此前二者只能选一，
 * 于是 serve 里工具侧发出的事件（`ask_user` 的 `question`、`todo_write` 的 `todo`、`plan_write`
 * 的 `plan`）被装配成 `SilentEventPort` ——**UI 永远看不到它们**，而 `question` 事件恰恰是提问卡
 * 在对话流里的那一块（用户报障截图里有的那块，实际只在「切换过工作区」之后才偶然出现，
 * 因为 `switchWorkspace` 重建配置时顺手换成了服务端端口）。
 *
 * 与 {@link ConsoleLiveView}/`CompositeLiveView` 同一取舍：**组合优于二选一**，且成员之间**互不拖累**
 * ——任一出错（客户端断开时 send 抛错、OTLP 导出抖动）都只记一条 warn，其余出口照常收到事件，
 * 绝不因为一个观测出口把回合打断。
 */
export class CompositeEventPort implements EventPort {
  /** 端口标识（含成员名，便于日志与判据辨认）。 */
  public readonly name: string;
  /** 扇出成员（构造期固定，运行期不变）。 */
  private readonly members: readonly EventPort[];

  /**
   * @param members 扇出成员（按序调用；空数组合法，等价于静默）。
   */
  public constructor(members: readonly EventPort[]) {
    this.members = [...members];
    this.name = 'composite:' + this.members.map((port) => port.name).join('+');
  }

  /**
   * 把事件按序送给每个成员；单个成员抛错只记日志（fail-soft），不影响其余成员与调用方。
   * @param event 会话事件。
   * @returns 无返回值。
   */
  public emit(event: SessionEvent): void {
    for (const port of this.members) {
      try {
        port.emit(event);
      } catch (error) {
        log.warn('event.composite.member_failed', {
          port: port.name,
          type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 冲刷全部**有缓冲**的成员（无 `flush` 的成员跳过）；单个成员失败同样只记日志。
   * @returns 全部成员冲刷完成后 resolve。
   */
  public async flush(): Promise<void> {
    for (const port of this.members) {
      if (port.flush === undefined) continue;
      try {
        await port.flush();
      } catch (error) {
        log.warn('event.composite.flush_failed', {
          port: port.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
