import type { Writable } from 'node:stream';
import type { ToolInputDelta } from '../../ports/model.js';
import type { ToolInputSink } from '../../ports/toolInputSink.js';
import { clearLine, renderToolInputProgress } from '../../tui/render.js';

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
  readonly name = 'console-live-view';
  private readonly states = new Map<string, { name: string; acc: string }>();

  constructor(private readonly out: Writable = process.stderr) {}

  onToolInput(delta: ToolInputDelta): void {
    // 仅 TTY 实时刷新；非 TTY（管道／重定向／CI）静默，避免把控制码刷进 stdout 或日志。
    const tty = (this.out as unknown as { isTTY?: boolean }).isTTY;
    if (!tty) return;
    const key = delta.id ?? delta.name ?? 'default';
    const prev = this.states.get(key) ?? { name: delta.name ?? 'tool', acc: '' };
    prev.name = delta.name ?? prev.name;
    prev.acc += delta.partialJson;
    this.states.set(key, prev);
    const line = renderToolInputProgress({ name: prev.name, json: prev.acc });
    this.out.write(`${clearLine()}${line}`);
  }
}
