/**
 * TUI ↔ Agent 桥（#S35 收口）——把 `omniharness tui` 从「回声 stub」接到真实任务回路上。
 *
 * ## 断点在哪、怎么接
 *
 * `Interactive.startInteractive` 的 `send` 回调自注释起就写明应「调用 Agent 主循环」，
 * 但 CLI 侧一直给它的是硬编码回声（「未接模型」）。本桥补上最后一段：
 *
 * 1. **事件流向**：`EventPort` 是纯 sink（emit-only，无订阅 API），所以桥提供一个
 *    **转播端口**（`port()`）——由组合根（`cliAgentCmds.runTui`）把它装配进
 *    `config.events`，会话事件在落日志的同时被映射成 `TuiEvent` 推进桥内队列；
 * 2. **任务执行**：`send(input)` 首轮走 `runTask`、后续走 `resume(sessionId, …)`
 *    ——整个 TUI 会话是**一个**真实会话（上下文跨轮累积），不是每行输入一个新会话；
 * 3. **错误路径**：任务抛错被收成一条 `error` 事件渲染，随后队列收尾——不炸掉交互循环。
 *
 * ## 诚实边界
 *
 * 桥只做「事件 → 渲染事件」的映射与多轮衔接，不新增任何模型语义；`question`（审批提问）
 * 只是渲染，答复仍走既有的 userResponder 装配（与 exec 同口径）。
 */
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { SessionEvent } from '../ports/runtime/event.js';
import type { TuiEvent } from '../ports/tui/tuiEvent.js';
import type { TuiTaskRunner } from '../ports/tui/tuiTaskRunner.js';

/** 单条文本载荷的展示截断上限（字符）：TUI 行不是日志文件，超长正文以省略号收尾。 */
const TEXT_LIMIT = 400;
/** 工具参数预览的截断上限（字符）。 */
const ARGS_LIMIT = 80;

/**
 * TUI ↔ Agent 桥：把会话事件流转成 TUI 渲染事件流，并把用户输入接进真实任务回路。
 */
export class TuiAgentBridge {
  /** 任务执行面（构造后经 {@link TuiAgentBridge.attach} 绑定）。 */
  private runner: TuiTaskRunner | undefined;
  /** 当前会话 ID（首轮 runTask 后确立；后续 resume 复用）。 */
  private sessionId: string | undefined;
  /** 活跃 `send` 的事件出口（无活跃会话时为 undefined，事件被丢弃——与会话日志无关联的观测不渲染）。 */
  private sink: ((ev: TuiEvent) => void) | undefined;

  /**
   * 取会话事件的转播端口（组合根把它装配进 `config.events`）。
   * @returns 只映射、不落盘的事件端口（落盘仍由 runtime 既有存储链完成）
   */
  public port(): EventPort {
    const bridge = this;
    return {
      name: 'tui-agent-bridge',
      emit(event: SessionEvent): void {
        const mapped = bridge.mapEvent(event);
        if (mapped !== undefined) {
          bridge.sink?.(mapped);
        }
      },
    };
  }

  /**
   * 绑定任务执行面（必须在首次 {@link TuiAgentBridge.send} 之前调用）。
   * @param runner 任务执行面（生产为 `Agent`，测试可为假实现）
   * @returns 无返回值。
   */
  public attach(runner: TuiTaskRunner): void {
    this.runner = runner;
  }

  /** 当前会话 ID（未跑过为 undefined；测试与上层提示用）。 */
  public get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * 处理一行用户输入：跑一轮真实任务并把事件流（含错误）转成异步可迭代渲染事件。
   * @param input 用户输入文本（交互层已 trim）。
   * @returns TUI 渲染事件流；结束时保证队列已清空。
   * @throws Error 未先 {@link TuiAgentBridge.attach} 即调用时抛出（编程错误，不留静默回声）。
   */
  public send(input: string): AsyncIterable<TuiEvent> {
    const bridge = this;
    async function* run(): AsyncGenerator<TuiEvent> {
      if (bridge.runner === undefined) {
        throw new Error('TuiAgentBridge 未绑定任务执行面（attach）即被 send');
      }
      const runner: TuiTaskRunner = bridge.runner;
      const queue: TuiEvent[] = [];
      let notify: (() => void) | undefined;
      const push = (ev: TuiEvent): void => {
        queue.push(ev);
        const wake = notify;
        notify = undefined;
        wake?.();
      };
      const wait = (): Promise<void> =>
        new Promise<void>((resolve) => {
          notify = resolve;
        });
      bridge.sink = push;
      let failure: Error | undefined;
      let done = false;
      const current = bridge.sessionId;
      const running: Promise<void> = (async () => {
        try {
          const result =
            current === undefined
              ? await runner.runTask(input)
              : await runner.resume(current, input);
          bridge.sessionId = result.sessionId;
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
        } finally {
          done = true;
          // 任务已落定：必须唤醒可能挂在 wait() 上的消费者，否则队列空 + done=true 的收尾
          // 永远不会被观察到（send 挂死，TUI 卡在「输入后无响应」）。
          const wake = notify;
          notify = undefined;
          wake?.();
        }
      })();
      try {
        while (true) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (done) break;
          await wait();
        }
        if (failure !== undefined) {
          yield { kind: 'error', text: failure.message };
        }
      } finally {
        void running;
        bridge.sink = undefined;
      }
    }
    return run();
  }

  /**
   * 会话事件 → TUI 渲染事件的映射表（映射不到的 类型 返回 undefined 丢弃）。
   * @param event 会话事件（append-only 日志的原始事件）
   * @returns 渲染事件；user/reasoning/model/todo/plan/session_meta 不渲染
   */
  private mapEvent(event: SessionEvent): TuiEvent | undefined {
    const payload = TuiAgentBridge.recordOf(event.payload);
    switch (event.type) {
      case 'assistant':
        return { kind: 'assistant', text: TuiAgentBridge.textOf(payload['content']) };
      case 'tool_call': {
        const name = TuiAgentBridge.textOf(payload['name']);
        return {
          kind: 'tool_call',
          text: name === '' ? '（未知工具）' : name,
          meta: TuiAgentBridge.truncate(TuiAgentBridge.jsonOf(payload['args']), ARGS_LIMIT),
        };
      }
      case 'tool_result': {
        const ok = payload['ok'] === true;
        const body =
          TuiAgentBridge.textOf(payload['output']) ||
          TuiAgentBridge.textOf(payload['error']) ||
          '（无输出）';
        return {
          kind: 'tool_result',
          text: TuiAgentBridge.truncate(body, TEXT_LIMIT),
          ...(ok ? {} : { meta: '失败' }),
        };
      }
      case 'question':
        return {
          kind: 'question',
          text: TuiAgentBridge.truncate(TuiAgentBridge.jsonOf(payload['questions']), TEXT_LIMIT),
        };
      case 'turn_diff':
        return {
          kind: 'turn_diff',
          text: TuiAgentBridge.truncate(TuiAgentBridge.textOf(payload['diff']), TEXT_LIMIT),
        };
      case 'system':
        return {
          kind: 'system',
          text: TuiAgentBridge.truncate(TuiAgentBridge.textOf(payload['content']), TEXT_LIMIT),
        };
      default:
        return undefined;
    }
  }

  /**
   * 载荷转 `Record`（非对象/null 视为空记录，映射端不判空散落）。
   * @param payload 事件载荷
   * @returns 键值记录
   */
  private static recordOf(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  }

  /**
   * 取字符串字段（非字符串一律空串，由调用方给缺省文案）。
   * @param value 原始值
   * @returns 字符串值或空串
   */
  private static textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  /**
   * 序列化为 JSON 文本（序列化失败回退空串——预览缺位可接受，渲染不能炸）。
   * @param value 原始值
   * @returns JSON 文本或空串
   */
  private static jsonOf(value: unknown): string {
    try {
      return value === undefined ? '' : (JSON.stringify(value) ?? '');
    } catch {
      return '';
    }
  }

  /**
   * 超长截断（保留省略号；上限内原样返回）。
   * @param text 原文
   * @param max 上限（字符）
   * @returns 截断后的文本
   */
  private static truncate(text: string, max: number): string {
    if (max <= 0) return '';
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  }
}
