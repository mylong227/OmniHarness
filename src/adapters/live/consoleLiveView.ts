import type { Writable } from 'node:stream';
import type { ToolInputDelta } from '../../ports/model/model.js';
import type { ToolInputSink } from '../../ports/tool/toolInputSink.js';
import { clearLine, renderToolInputProgress } from '../../tui/tuiRenderer.js';

/**
 * @beta
 * 控制台实时视图（#B3）：把工具参数增量实时刷到 stderr。
 *
 * - TTY 环境：用 `\r` 原地刷新同一行，呈现"参数逐字符增长"的渐进效果。
 * - 非 TTY（管道 / 重定向 / CI）：静默，避免把控制码刷进 stdout 或日志。
 *
 * 不写 stdout，以免破坏 stdout 可能的机器消费（如 JSON 输出 / 管道）。
 */
export class ConsoleLiveView implements ToolInputSink {
  /** 控制台视图在 live 通道内的标识名。 */
  public readonly name = 'console-live-view';
  private readonly states = new Map<string, { name: string; acc: string }>();

  public constructor(
    private readonly out: Writable = process.stderr,
    /** 文本流式输出通道（V2.1）：--stream-text 时为 stdout，否则 undefined（不流式）。 */
    private readonly textOut?: Writable,
  ) {}

  /**
   * 工具参数增量实时刷到 stderr（仅 TTY；非 TTY 静默）。
   *
   * @param delta 工具输入增量事件
   
 * @returns 无返回值。
*/
  public onToolInput(delta: ToolInputDelta): void {
    // 仅 TTY 实时刷新；非 TTY（管道／重定向／CI）静默，避免把控制码刷进 stdout 或日志。
    const tty = (this.out as { isTTY?: unknown }).isTTY === true;
    if (!tty) return;
    const key = delta.id ?? delta.name ?? 'default';
    const prev = this.states.get(key) ?? { name: delta.name ?? 'tool', acc: '' };
    prev.name = delta.name ?? prev.name;
    prev.acc += delta.partialJson;
    this.states.set(key, prev);
    const line = renderToolInputProgress({ name: prev.name, json: prev.acc });
    this.out.write(`${clearLine()}${line}`);
  }

  /**
   * 文本增量流式输出（V2.1）：仅当构造时注入了文本通道（--stream-text opt-in）才写。
   * 默认不流式——exec 末尾会统一打印 finalText，重复输出会污染机器消费的 stdout。
   * @param text 模型文本增量
   * @returns 无返回值。
   */
  public onTextDelta(text: string): void {
    this.textOut?.write(text);
  }
}
