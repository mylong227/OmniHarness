import type {
  A2aArtifact,
  A2aStreamResponse,
  A2aTask,
  A2aTaskState,
  A2aTaskStatus,
} from './a2aProtocol.ts';
import { A2A_ERROR_TASK_NOT_FOUND } from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';
import { LimitEnv } from '../util/limitEnv.ts';
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
  /**
   * 任务级元数据合并补丁（值为 `undefined` 表示删除该键；合并后为空则移除整个字段）。
   *
   * 任务内认证（`auth_required`）用它挂/摘 `authChallenge`：状态与元数据必须同时可写，
   * 否则客户端会看到「状态已回到 working、但旧 challenge 还留着」的自相矛盾快照。
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
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
  /**
   * 任务总量上限（`OMNI_A2A_MAX_TASKS` 可调，默认 500；构造期读取）。
   *
   * 2026-10-27 审计收口：records Map 此前无上限——每个 `message/send`（远端可控的唯一 id）
   * 永久占一条记录，长跑 serve 即远程内存耗尽向量（`OMNI_A2A_HOST=0.0.0.0` 时尤甚）。
   * 超限时**先淘汰终态任务**（Map 插入序即创建序），无终态可淘汰才淘汰最老的非终态任务
   * （有界内存优先于保留全部状态；每次淘汰都留 warn 轨迹）。与 GraphRunRegistry 的
   * MAX_RUNS 淘汰同口径。
   */
  private readonly maxTasks: number = LimitEnv.int('OMNI_A2A_MAX_TASKS', 500);
  /** 单任务产出上限（超出丢最旧并告警；防长流任务的 artifacts 无界增长）。 */
  private readonly maxArtifactsPerTask: number = LimitEnv.int(
    'OMNI_A2A_MAX_ARTIFACTS_PER_TASK',
    200,
  );
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
    this.evictBeyondLimit();
    return task;
  }

  /**
   * 超上限时淘汰旧任务（终态优先；Map 插入序 = 创建序）。
   * @returns 无返回值。
   */
  private evictBeyondLimit(): void {
    if (this.records.size <= this.maxTasks) return;
    for (const terminalOnly of [true, false]) {
      for (const [key, record] of this.records) {
        if (this.records.size <= this.maxTasks) return;
        const isTerminal = A2aTaskStore.isTerminal(record.task.status.state);
        if (terminalOnly && !isTerminal) continue;
        this.records.delete(key);
        log.warn('a2a.task.evicted', {
          taskId: key,
          state: record.task.status.state,
          terminal: isTerminal,
          limit: this.maxTasks,
        });
      }
    }
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
   * 列出全部任务（按状态时间倒序，最近更新的在前；同时间按 id 倒序兜底）。
   *
   * 二级键不可省：`timestamp` 只到毫秒，同毫秒创建的任务若顺序取决于 Map 插入序，
   * 游标分页会重复或漏项（`tasks/list` 的稳定排序依赖这里）。比较用**码元序**而非
   * `localeCompare`——后者随区域设置变化，会和分页游标的码元比较口径打架。
   * @returns 任务快照数组。
   */
  public list(): readonly A2aTask[] {
    return [...this.records.values()]
      .map((record) => record.task)
      .sort((a, b) => {
        const at = a.status.timestamp ?? '';
        const bt = b.status.timestamp ?? '';
        if (at !== bt) return at < bt ? 1 : -1;
        if (a.id === b.id) return 0;
        return a.id < b.id ? 1 : -1;
      });
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
      // 单任务产出上限：超出丢最旧（有界内存优先；每次都留 warn 轨迹）。
      const existing = record.task.artifacts ?? [];
      const overflow = existing.length + 1 - this.maxArtifactsPerTask;
      const artifacts = overflow > 0 ? existing.slice(overflow) : existing;
      if (overflow > 0) {
        log.warn('a2a.task.artifacts.evicted', {
          taskId: id,
          dropped: overflow,
          limit: this.maxArtifactsPerTask,
        });
      }
      const task: A2aTask = {
        ...record.task,
        artifacts: [...artifacts, patch.artifact],
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
    if (
      patch.state !== undefined ||
      patch.message !== undefined ||
      patch.error !== undefined ||
      patch.metadata !== undefined
    ) {
      const status: A2aTaskStatus = {
        state: patch.state ?? record.task.status.state,
        timestamp: new Date().toISOString(),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
      };
      const task: A2aTask = A2aTaskStore.withMetadata(
        {
          ...record.task,
          status,
          ...(patch.error !== undefined ? { error: patch.error } : {}),
        },
        patch.metadata,
      );
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
   * 应用任务级元数据合并补丁（`undefined` 值删键；合并后为空则移除字段）。
   * @param task 已应用状态/错误补丁的任务快照。
   * @param patch 元数据补丁；未提供时原样返回。
   * @returns 应用补丁后的任务快照。
   */
  private static withMetadata(
    task: A2aTask,
    patch: Readonly<Record<string, unknown>> | undefined,
  ): A2aTask {
    if (patch === undefined) return task;
    const merged: Record<string, unknown> = { ...(task.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    if (Object.keys(merged).length > 0) {
      return { ...task, metadata: merged };
    }
    const copy: { -readonly [K in keyof A2aTask]: A2aTask[K] } = { ...task };
    delete copy.metadata;
    return copy;
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
