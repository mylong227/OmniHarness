import type { SessionEvent } from '../ports/runtime/event.ts';
import type { WorkflowMemoryPort } from '../ports/memory/workflowMemory.ts';

/**
 * Workflow Memory 自动沉淀/召回（P4）。
 *
 * 标准边界：
 * - 只在**成功收敛**（未截断/未取消/验证未失败）时记录；
 * - 只记录工具**名称 + 目标摘要**，不记录原始输出；
 * - 召回只作为**参考提示**注入，不自动重放（副作用不可无条件复用）。
 */
export class WorkflowMemoryRecorder {
  /**
   * @param memory workflow memory 端口
   */
  public constructor(private readonly memory: WorkflowMemoryPort) {}

  /**
   * 从事件流最后一条 user 消息取当前任务。
   * @param events 会话事件
   * @returns 任务文本；无 user 事件时 undefined
   */
  public static taskOf(events: readonly SessionEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'user') continue;
      const content = (event.payload as { readonly content?: unknown }).content;
      if (typeof content === 'string' && content.trim() !== '') return content.trim();
    }
    return undefined;
  }

  /**
   * 召回并生成可注入的系统提示。
   * @param task 当前任务
   * @returns 提示文本；无相似 workflow 时 undefined
   */
  public async prime(task: string | undefined): Promise<string | undefined> {
    if (task === undefined) return undefined;
    try {
      const entries = await this.memory.recall(task, 1);
      const entry = entries[0];
      if (entry === undefined) return undefined;
      return (
        `[WorkflowMemory] 相似任务曾成功走完以下步骤（仅参考，不自动重放）：` +
        entry.steps
          .slice(0, 8)
          .map((step) => `→ ${step}`)
          .join(' ')
      );
    } catch {
      return undefined;
    }
  }

  /**
   * 从事件段提取工具序列并记录成功 workflow。
   * @param task 任务文本
   * @param events 本回合事件
   * @param success 是否成功收敛且未验证失败
   * @returns 无返回值
   */
  public async capture(
    task: string | undefined,
    events: readonly SessionEvent[],
    success: boolean,
  ): Promise<void> {
    if (!success || task === undefined) return;
    const steps: string[] = [];
    for (const event of events) {
      if (event.type !== 'tool_call') continue;
      const payload = event.payload as { readonly name?: unknown; readonly args?: unknown };
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (name === '') continue;
      const target = WorkflowMemoryRecorder.summarizeTarget(payload.args);
      steps.push(target === undefined ? name : `${name} ${target}`);
      if (steps.length >= 12) break;
    }
    if (steps.length < 2) return;
    try {
      await this.memory.remember(task, steps);
    } catch {
      // 记忆是增强，不是主状态。
    }
  }

  /**
   * 从工具参数提取目标摘要（path/command/url 优先）。
   * @param args 工具参数
   * @returns 摘要；无可用参数时 undefined
   */
  private static summarizeTarget(args: unknown): string | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    const record = args as Record<string, unknown>;
    for (const key of ['path', 'command', 'url', 'candidates']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim().slice(0, 120);
      }
      if (key === 'candidates' && Array.isArray(value)) {
        const first = value.find((item): item is string => typeof item === 'string');
        if (first !== undefined) return `patch:${first.slice(0, 80)}`;
      }
    }
    return undefined;
  }
}
