import { Id } from '../util/id.ts';
import { log } from '../util/logger.ts';
import type {
  A2aArtifact,
  A2aPushNotificationConfig,
  A2aStreamResponse,
  A2aTask,
} from './a2aProtocol.ts';
import {
  A2A_ERROR_INVALID,
  A2A_ERROR_TASK_NOT_CANCELABLE,
  A2A_ERROR_UNSUPPORTED_OPERATION,
} from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';
import { A2aTaskStore } from './a2aTaskStore.ts';
import type { A2aPushNotifications } from './a2aPushNotifications.ts';
import type { TaskHandler } from './a2aTaskHandler.ts';

/** 流式响应的回写器（由 A2aServer 绑定到具体 JSON-RPC id / 传输）。 */
export type A2aStreamResponder = (payload: unknown) => void;

/** A2A v1 方法集依赖。 */
export interface A2aV1MethodsOptions {
  /** 任务表。 */
  readonly tasks: A2aTaskStore;
  /** push notification 配置与投递。 */
  readonly push: A2aPushNotifications;
  /** 任务处理器（延迟读取：server.setTaskHandler 可能在构造之后）。 */
  readonly handler: () => TaskHandler | undefined;
}

/** 解析后的 v1 消息请求。 */
interface A2aParsedMessage {
  /** 文本（多个 text part 以换行拼接）。 */
  readonly text: string;
  /** 任务 / 消息 id。 */
  readonly messageId: string;
  /** 上下文 id。 */
  readonly contextId?: string;
  /** 是否立即返回（后台执行）。 */
  readonly returnImmediately: boolean;
  /** 请求内联的 push 配置。 */
  readonly pushConfig?: A2aPushNotificationConfig;
}

/**
 * A2A v1.0 方法实现：消息、任务生命周期、流式订阅与 push notification 配置。
 *
 * 与 `A2aServer` 的分工：本类只做**协议语义**（任务状态机 / 流事件 / 配置 CRUD），
 * 验签、JSON-RPC 收发与错误码映射留在 server——这样同一套语义可被 HTTP / WS / 内存
 * 传输复用，且认证边界只有一处实现。
 */
export class A2aV1Methods {
  /** 任务表。 */
  private readonly tasks: A2aTaskStore;
  /** push notification 配置。 */
  private readonly push: A2aPushNotifications;
  /** 处理器读取器。 */
  private readonly handler: () => TaskHandler | undefined;

  /**
   * @param options 任务表、push 配置与处理器读取器。
   */
  public constructor(options: A2aV1MethodsOptions) {
    this.tasks = options.tasks;
    this.push = options.push;
    this.handler = options.handler;
    this.tasks.setObserver((event, task) => this.push.notify(task.id, event));
  }

  /**
   * `message/send`：创建任务并执行（`configuration.returnImmediately` 时后台执行并立即返回）。
   * @param params JSON-RPC 参数。
   * @returns 任务（阻塞模式为终态；立即返回模式为 submitted）。
   */
  public async send(params: unknown): Promise<A2aTask> {
    const parsed = this.parseMessage(params);
    const task = this.createTask(parsed);
    if (!parsed.returnImmediately) {
      return await this.execute(task, parsed.text);
    }
    void this.execute(task, parsed.text).catch((error: unknown) => {
      log.warn('a2a.task.background.failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return task;
  }

  /**
   * `message/stream`：先回 Task 快照，再按状态/产出事件流式回写，终态时收尾。
   * @param params JSON-RPC 参数。
   * @param respond 流式回写器（同一 JSON-RPC id 的多条响应）。
   * @returns 流结束（终态事件已发出）。
   */
  public async stream(params: unknown, respond: A2aStreamResponder): Promise<void> {
    const parsed = this.parseMessage(params);
    const task = this.createTask(parsed);
    let sawFinal = false;
    const unsubscribe = this.tasks.subscribe(task.id, (event) => {
      sawFinal = sawFinal || event.final;
      respond(event.payload);
    });
    try {
      respond({ task } satisfies A2aStreamResponse);
      await this.execute(task, parsed.text);
    } finally {
      unsubscribe?.();
    }
    if (!sawFinal) respond(A2aV1Methods.finalSnapshot(this.tasks.require(task.id)));
  }

  /**
   * `tasks/get`：查询任务当前态。
   * @param params JSON-RPC 参数（`id` 或 `taskId`）。
   * @returns 任务快照。
   */
  public get(params: unknown): A2aTask {
    return this.tasks.require(A2aV1Methods.taskIdOf(A2aV1Methods.recordOf(params)));
  }

  /**
   * `tasks/cancel`：中止在跑任务并落 canceled（终态任务返回 `TaskNotCancelable`）。
   * @param params JSON-RPC 参数（`id` 或 `taskId`）。
   * @returns 取消后的任务快照。
   */
  public cancel(params: unknown): A2aTask {
    const taskId = A2aV1Methods.taskIdOf(A2aV1Methods.recordOf(params));
    const task = this.tasks.require(taskId);
    if (A2aTaskStore.isTerminal(task.status.state)) {
      throw new A2aProtocolError(
        `任务不可取消（当前状态 ${task.status.state}）`,
        A2A_ERROR_TASK_NOT_CANCELABLE,
      );
    }
    this.handler()?.cancel?.(taskId);
    return this.tasks.update(taskId, { state: 'canceled' });
  }

  /**
   * `tasks/subscribe`：先回当前 Task 快照，再持续回写后续事件直到终态。
   * @param params JSON-RPC 参数（`id` 或 `taskId`）。
   * @param respond 流式回写器。
   * @returns 流结束（任务到达终态或订阅被解除）。
   */
  public async subscribe(params: unknown, respond: A2aStreamResponder): Promise<void> {
    const taskId = A2aV1Methods.taskIdOf(A2aV1Methods.recordOf(params));
    const task = this.tasks.require(taskId);
    if (A2aTaskStore.isTerminal(task.status.state)) {
      throw new A2aProtocolError(
        `任务已处于终态（${task.status.state}），不能订阅`,
        A2A_ERROR_UNSUPPORTED_OPERATION,
      );
    }
    await new Promise<void>((resolve) => {
      const unsubscribe = this.tasks.subscribe(taskId, (event) => {
        respond(event.payload);
        if (!event.final) return;
        unsubscribe?.();
        resolve();
      });
      respond({ task } satisfies A2aStreamResponse);
    });
  }

  /**
   * `tasks/list`：列出任务（可按 contextId / state 过滤）。
   * @param params JSON-RPC 参数。
   * @returns `{ tasks, nextPageToken }`。
   */
  public list(params: unknown): {
    readonly tasks: readonly A2aTask[];
    readonly nextPageToken: string;
  } {
    const record = A2aV1Methods.recordOf(params);
    const contextId = typeof record['contextId'] === 'string' ? record['contextId'] : undefined;
    const state = typeof record['state'] === 'string' ? record['state'] : undefined;
    return {
      tasks: this.tasks
        .list()
        .filter((task) => contextId === undefined || task.contextId === contextId)
        .filter((task) => state === undefined || task.status.state === state),
      nextPageToken: '',
    };
  }

  /**
   * `tasks/pushNotificationConfig/set`：为任务注册 webhook。
   * @param params JSON-RPC 参数。
   * @returns `{ taskId, pushNotificationConfig }`。
   */
  public pushSet(params: unknown): unknown {
    const record = A2aV1Methods.recordOf(params);
    const taskId = A2aV1Methods.taskIdOf(record);
    this.tasks.require(taskId);
    const config = this.pushConfigOf(record);
    return { taskId, pushNotificationConfig: this.push.set(taskId, config) };
  }

  /**
   * `tasks/pushNotificationConfig/get`：读取任务的通知配置。
   * @param params JSON-RPC 参数。
   * @returns `{ taskId, pushNotificationConfig }`。
   */
  public pushGet(params: unknown): unknown {
    const record = A2aV1Methods.recordOf(params);
    const taskId = A2aV1Methods.taskIdOf(record);
    this.tasks.require(taskId);
    const configId = A2aV1Methods.configIdOf(record);
    return { taskId, pushNotificationConfig: this.push.get(taskId, configId) };
  }

  /**
   * `tasks/pushNotificationConfig/list`：列出任务的全部通知配置。
   * @param params JSON-RPC 参数。
   * @returns `{ configs }`。
   */
  public pushList(params: unknown): unknown {
    const record = A2aV1Methods.recordOf(params);
    const taskId = A2aV1Methods.taskIdOf(record);
    this.tasks.require(taskId);
    return { configs: this.push.list(taskId) };
  }

  /**
   * `tasks/pushNotificationConfig/delete`：删除通知配置（幂等）。
   * @param params JSON-RPC 参数。
   * @returns `{ deleted }`。
   */
  public pushDelete(params: unknown): unknown {
    const record = A2aV1Methods.recordOf(params);
    const taskId = A2aV1Methods.taskIdOf(record);
    this.tasks.require(taskId);
    const deleted = this.push.delete(taskId, A2aV1Methods.configIdOf(record));
    return { deleted };
  }

  /**
   * 解析 `message/send|stream` 参数（兼容 `kind` 缺省与 0.x 的 `contextId` 位置）。
   * @param params JSON-RPC 参数。
   * @returns 解析结果。
   */
  private parseMessage(params: unknown): A2aParsedMessage {
    const record = A2aV1Methods.recordOf(params);
    const message = A2aV1Methods.recordOf(record['message']);
    const parts = Array.isArray(message['parts']) ? message['parts'] : [];
    const texts: string[] = [];
    for (const part of parts) {
      const item = A2aV1Methods.recordOf(part);
      if (item['type'] === 'text' && typeof item['text'] === 'string') texts.push(item['text']);
    }
    const text = texts.join('\n').trim();
    if (text === '') {
      throw new A2aProtocolError('message 缺少文本 part', A2A_ERROR_INVALID);
    }
    const configuration = A2aV1Methods.recordOf(record['configuration']);
    const inline = A2aV1Methods.recordOf(
      configuration['pushNotificationConfig'] ?? configuration['taskPushNotificationConfig'],
    );
    const messageId =
      typeof message['messageId'] === 'string' ? message['messageId'] : Id.id('task');
    const contextId =
      typeof record['contextId'] === 'string'
        ? record['contextId']
        : typeof message['contextId'] === 'string'
          ? message['contextId']
          : undefined;
    return {
      text,
      messageId,
      ...(contextId !== undefined ? { contextId } : {}),
      returnImmediately:
        configuration['returnImmediately'] === true || configuration['return_immediately'] === true,
      ...(typeof inline['url'] === 'string' ? { pushConfig: this.pushConfigOf(inline) } : {}),
    };
  }

  /**
   * 创建任务并登记可选的内联 push 配置。
   * @param parsed 解析结果。
   * @returns 新任务（submitted）。
   */
  private createTask(parsed: A2aParsedMessage): A2aTask {
    const task = this.tasks.create(parsed.messageId, parsed.contextId);
    this.registerInlinePush(task.id, parsed.pushConfig);
    return task;
  }

  /**
   * 执行任务并落终态（completed / failed / canceled）。异常收敛为 failed，绝不外抛。
   * @param task 任务快照。
   * @param prompt 用户文本。
   * @returns 终态任务。
   */
  private async execute(task: A2aTask, prompt: string): Promise<A2aTask> {
    const handler = this.handler();
    if (handler === undefined) {
      return this.tasks.update(task.id, { state: 'failed', error: '未配置任务处理器' });
    }
    this.tasks.update(task.id, { state: 'working' });
    try {
      const result = await handler.handle({
        taskId: task.id,
        task: prompt,
        ...(task.contextId !== undefined ? { parentSessionId: task.contextId } : {}),
      });
      if (result.canceled === true) {
        return this.tasks.update(task.id, { state: 'canceled' });
      }
      if (result.ok) {
        const artifact: A2aArtifact = {
          artifactId: `${task.id}-output`,
          parts: [{ type: 'text', text: result.output }],
        };
        return this.tasks.update(task.id, { artifact, state: 'completed' });
      }
      return this.tasks.update(task.id, {
        state: 'failed',
        error: result.error ?? '任务失败',
      });
    } catch (error) {
      return this.tasks.update(task.id, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 登记请求内联的 push 配置（若给出）。
   * @param taskId 任务 id。
   * @param config 配置（可选）。
   * @returns 无返回值。
   */
  private registerInlinePush(taskId: string, config: A2aPushNotificationConfig | undefined): void {
    if (config !== undefined) this.push.set(taskId, config);
  }

  /**
   * 从参数里解析 push 配置（兼容嵌套 `pushNotificationConfig` 与扁平字段）。
   * @param record 参数对象。
   * @returns 配置（url 必填）。
   */
  private pushConfigOf(record: Record<string, unknown>): A2aPushNotificationConfig {
    const nested = A2aV1Methods.recordOf(record['pushNotificationConfig']);
    const source = typeof nested['url'] === 'string' ? nested : record;
    const url = typeof source['url'] === 'string' ? source['url'] : '';
    if (!/^https?:\/\//u.test(url)) {
      throw new A2aProtocolError(
        'pushNotificationConfig.url 必须是 http(s) URL',
        A2A_ERROR_INVALID,
      );
    }
    const authentication = A2aV1Methods.recordOf(source['authentication']);
    return {
      url,
      ...(typeof source['id'] === 'string' ? { id: source['id'] } : {}),
      ...(typeof source['token'] === 'string' ? { token: source['token'] } : {}),
      ...(Object.keys(authentication).length > 0
        ? {
            authentication: {
              ...(Array.isArray(authentication['schemes'])
                ? {
                    schemes: authentication['schemes'].filter(
                      (item): item is string => typeof item === 'string',
                    ),
                  }
                : {}),
              ...(typeof authentication['credentials'] === 'string'
                ? { credentials: authentication['credentials'] }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * 构造终态快照事件（用于订阅/流未显式发出 final 的兜底）。
   * @param task 终态任务。
   * @returns 终态 statusUpdate 载荷。
   */
  private static finalSnapshot(task: A2aTask): A2aStreamResponse {
    return {
      statusUpdate: {
        taskId: task.id,
        ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
        status: task.status,
        final: true,
      },
    };
  }

  /**
   * 从参数取任务 id（`id` 优先，兼容 `taskId`）。
   * @param record 参数对象。
   * @returns 任务 id。
   */
  private static taskIdOf(record: Record<string, unknown>): string {
    const value = record['id'] ?? record['taskId'];
    if (typeof value !== 'string' || value === '') {
      throw new A2aProtocolError('缺少任务 id（id / taskId）', A2A_ERROR_INVALID);
    }
    return value;
  }

  /**
   * 从参数取 push 配置 id（兼容 `pushNotificationConfigId` / `configId`）。
   * @param record 参数对象。
   * @returns 配置 id；未给出为 undefined。
   */
  private static configIdOf(record: Record<string, unknown>): string | undefined {
    const value = record['pushNotificationConfigId'] ?? record['configId'] ?? record['config_id'];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /**
   * 归一为普通对象。
   * @param value 待判值。
   * @returns 普通对象。
   */
  private static recordOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
