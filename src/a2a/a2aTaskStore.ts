import type {
  A2aArtifact,
  A2aStreamResponse,
  A2aTask,
  A2aTaskState,
  A2aTaskStatus,
} from './a2aProtocol.ts';
import { A2A_ERROR_TASK_NOT_FOUND } from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';
import { log } from '../util/logger.ts';

/** 一条任务流事件（订阅者与 push 通知共用同一载荷）。 */
export interface A2aTaskEvent {
  /** 流式响应载荷（task / statusUpdate / artifactUpdate）。 */
  readonly payload: A2aStreamResponse;
  /** 是否为该任务的最后一条事件。 */
  readonly final: boolean;
}

/** 任务更新补丁。 */
export interface A2aTaskPatch {
  /** 新状态（缺省保持）。 */
  readonly state?: A2aTaskState;
  /** 新状态说明消息。 */
  readonly message?: A2aTask['status']['message'];
  /** 失败原因。 */
  readonly error?: string | undefined;
  /** 新增产出。 */
  readonly artifact?: A2aArtifact;
}

/** 任务记录（任务本体 + 订阅者）。 */
interface A2aTaskRecord {
  /** 当前任务快照（更新时就地替换）。 */
  task: A2aTask;
  /** 订阅回调集合。 */
  readonly listeners: Set<(event: A2aTaskEvent) => void>;
}

/**
 * A2A 任务表：状态机 + 流事件广播 + push 观察者。
 *
 * 并发语义：所有更新均为同步临界区（Node 单线程），`create → update → 广播` 之间不插入
 * `await`，因此订阅者不会错过「订阅快照」与「后续更新」之间的任何一条事件。
 */
export class A2aTaskStore {
  /** 任务记录表（id → 记录）。 */
  private readonly records = new Map<string, A2aTaskRecord>();
  /** 任务事件观察者（push notification 用；缺省不通知）。 */
  private observer: ((event: A2aTaskEvent, task: A2aTask) => void) | undefined;

  /**
   * 设置任务事件观察者（服务端接 push notification）。
   * @param observer 观察者（每条流事件调用一次）。
   * @returns 无返回值。
   */
  public setObserver(observer: (event: A2aTaskEvent, task: A2aTask) => void): void {
    this.observer = observer;
  }

  /**
   * 创建任务（初始状态 submitted）。
   * @param id 任务 id。
   * @param contextId 可选上下文 id。
   * @returns 新建任务。
   */
  public create(id: string, contextId?: string): A2aTask {
    const task: A2aTask = {
      id,
      ...(contextId !== undefined ? { contextId } : {}),
      status: { state: 'submitted', timestamp: new Date().toISOString() },
    };
    this.records.set(id, { task, listeners: new Set() });
    return task;
  }

  /**
   * 查询任务。
   * @param id 任务 id。
   * @returns 任务快照；不存在为 undefined。
   */
  public get(id: string): A2aTask | undefined {
    return this.records.get(id)?.task;
  }

  /**
   * 查询任务，不存在即抛 `TaskNotFoundError`。
   * @param id 任务 id。
   * @returns 任务快照。
   */
  public require(id: string): A2aTask {
    const task = this.get(id);
    if (task === undefined) {
      throw new A2aProtocolError(`未知任务: ${id}`, A2A_ERROR_TASK_NOT_FOUND);
    }
    return task;
  }

  /**
   * 列出全部任务（按状态时间倒序，最近更新的在前）。
   * @returns 任务快照数组。
   */
  public list(): readonly A2aTask[] {
    return [...this.records.values()]
      .map((record) => record.task)
      .sort((a, b) => (b.status.timestamp ?? '').localeCompare(a.status.timestamp ?? ''));
  }

  /**
   * 更新任务状态/产出并广播事件（终态任务不再改写状态，先到的终态获胜）。
   * @param id 任务 id。
   * @param patch 更新内容。
   * @returns 更新后的任务快照。
   */
  public update(id: string, patch: A2aTaskPatch): A2aTask {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new A2aProtocolError(`未知任务: ${id}`, A2A_ERROR_TASK_NOT_FOUND);
    }
    if (
      patch.state !== undefined &&
      A2aTaskStore.isTerminal(record.task.status.state) &&
      patch.state !== record.task.status.state
    ) {
      return record.task;
    }
    if (patch.artifact !== undefined) {
      const task: A2aTask = {
        ...record.task,
        artifacts: [...(record.task.artifacts ?? []), patch.artifact],
      };
      record.task = task;
      this.publish(record, {
        payload: {
          artifactUpdate: {
            taskId: id,
            ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
            artifact: patch.artifact,
            final: false,
          },
        },
        final: false,
      });
    }
    if (patch.state !== undefined || patch.message !== undefined || patch.error !== undefined) {
      const status: A2aTaskStatus = {
        state: patch.state ?? record.task.status.state,
        timestamp: new Date().toISOString(),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
      };
      const task: A2aTask = {
        ...record.task,
        status,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
      };
      record.task = task;
      this.publish(record, {
        payload: {
          statusUpdate: {
            taskId: id,
            ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
            status,
            final: A2aTaskStore.isTerminal(status.state),
          },
        },
        final: A2aTaskStore.isTerminal(status.state),
      });
    }
    return record.task;
  }

  /**
   * 订阅任务后续事件（不发送当前快照；调用方需先发快照再订阅，或自行处理首帧）。
   * @param id 任务 id。
   * @param listener 事件回调。
   * @returns 取消订阅函数；任务不存在时为 undefined。
   */
  public subscribe(id: string, listener: (event: A2aTaskEvent) => void): (() => void) | undefined {
    const record = this.records.get(id);
    if (record === undefined) return undefined;
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /**
   * 判断状态是否为终态（流式响应的收尾条件）。
   * @param state 任务状态。
   * @returns 终态为 true。
   */
  public static isTerminal(state: A2aTaskState): boolean {
    return (
      state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
    );
  }

  /**
   * 向订阅者与观察者广播一条事件（单个订阅者异常不影响其余订阅者）。
   * @param record 任务记录。
   * @param event 事件。
   * @returns 无返回值。
   */
  private publish(record: A2aTaskRecord, event: A2aTaskEvent): void {
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch (error) {
        log.warn('a2a.task.listener.failed', {
          taskId: record.task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      this.observer?.(event, record.task);
    } catch (error) {
      log.warn('a2a.task.observer.failed', {
        taskId: record.task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
