import type { SessionEvent } from '../ports/event.js';
import type { EventPort } from '../ports/eventPort.js';
import type { HookConsumer } from './formats.js';
import { CodexHooksMapper } from './codexHooksMapper.js';
import { ClaudeCodeHooksMapper } from './claudeCodeHooksMapper.js';

/**
 * hooks 兼容层适配器（实现 EventPort）。
 * 把内部 SessionEvent 实时映射为 codex-claude / claude-code 两种外部 hooks
 * 事件格式，并推送给订阅消费者。可作为观测端口注入 runtime，
 * 使外部 hooks 消费者无需改动即可消费 OmniHarness 事件流。
 */
export class HooksCompatAdapter implements EventPort {
  /** 端口名：hooks 兼容适配器（hooks-compat）。 */
  public readonly name = 'hooks-compat';

  private readonly codex = new CodexHooksMapper();
  private readonly claude = new ClaudeCodeHooksMapper();
  private sequence = 0;

  /**
   * @param consumer 消费者回调，每次映射产出一条外部 hook 事件信封。
   */
  public constructor(private readonly consumer: HookConsumer) {}

  /** 接收内部事件并映射为两种外部格式后推送。
   * @returns 无返回值。
   */
  public emit(event: SessionEvent): void {
    this.sequence += 1;
    this.consumer(this.codex.map(event, this.sequence));
    this.consumer(this.claude.map(event, this.sequence));
  }
}
