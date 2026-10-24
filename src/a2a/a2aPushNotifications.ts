import { Id } from '../util/id.ts';
import { log } from '../util/logger.ts';
import { SsrfGuard } from '../security/ssrfGuard.ts';
import type { SsrfOptions } from '../security/ssrfGuard.ts';
import type { A2aPushNotificationConfig, A2aStreamResponse } from './a2aProtocol.ts';
import { A2A_ERROR_TASK_NOT_FOUND } from './a2aProtocol.ts';
import { A2aProtocolError } from './a2aProtocolError.ts';
import type { A2aTaskEvent } from './a2aTaskStore.ts';

/** 默认 webhook 超时（毫秒）：通知失败不得拖住任务收尾。 */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/** PushNotifications 依赖（测试可注入 fetch）。 */
export interface A2aPushNotificationsOptions {
  /** fetch 实现（缺省 globalThis.fetch）。 */
  readonly fetchImpl?: typeof fetch;
  /** webhook 超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** SSRF 策略（缺省放行私有网段、始终拦截云元数据）。 */
  readonly ssrf?: SsrfOptions;
}

/**
 * A2A push notification 配置与 webhook 投递。
 *
 * - 配置按 taskId 分桶，支持 set / get / list / delete（delete 幂等）。
 * - 投递使用与流式响应相同的 `StreamResponse` 载荷（statusUpdate / artifactUpdate），
 *   并带上 `x-a2a-notification-token` 与可选 `Authorization` 头。
 * - 投递是**尽力而为**：失败只记日志，绝不影响任务状态机（webhook 不可用不能把任务判失败）。
 */
export class A2aPushNotifications {
  /** 任务 id → 配置列表。 */
  private readonly configs = new Map<string, A2aPushNotificationConfig[]>();
  /** fetch 实现。 */
  private readonly fetchImpl: typeof fetch;
  /** webhook 超时（毫秒）。 */
  private readonly timeoutMs: number;
  /** SSRF 策略。 */
  private readonly ssrf: SsrfOptions;

  /**
   * @param options 可注入的 fetch / 超时 / SSRF 策略。
   */
  public constructor(options: A2aPushNotificationsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.ssrf = options.ssrf ?? SsrfGuard.defaultSsrfOptions();
  }

  /**
   * 创建或更新任务的通知配置（缺 id 时分配一个）。
   * @param taskId 任务 id。
   * @param config 配置（url 必填）。
   * @returns 已落库的配置（含 id）。
   */
  public set(taskId: string, config: A2aPushNotificationConfig): A2aPushNotificationConfig {
    const stored: A2aPushNotificationConfig = {
      ...config,
      id: config.id ?? Id.id('push'),
    };
    const list = this.configs.get(taskId) ?? [];
    const index = list.findIndex((item) => item.id === stored.id);
    if (index >= 0) list[index] = stored;
    else list.push(stored);
    this.configs.set(taskId, list);
    return stored;
  }

  /**
   * 读取任务的通知配置（缺 configId 时返回第一条）。
   * @param taskId 任务 id。
   * @param configId 配置 id（可选）。
   * @returns 配置。
   */
  public get(taskId: string, configId?: string): A2aPushNotificationConfig {
    const list = this.configs.get(taskId) ?? [];
    const found = configId === undefined ? list[0] : list.find((item) => item.id === configId);
    if (found === undefined) {
      throw new A2aProtocolError(
        `未找到 push notification 配置: task=${taskId} config=${configId ?? '(first)'}`,
        A2A_ERROR_TASK_NOT_FOUND,
      );
    }
    return found;
  }

  /**
   * 列出任务的全部通知配置。
   * @param taskId 任务 id。
   * @returns 配置数组（拷贝）。
   */
  public list(taskId: string): readonly A2aPushNotificationConfig[] {
    return [...(this.configs.get(taskId) ?? [])];
  }

  /**
   * 删除通知配置（幂等：不存在返回 false，不抛错）。
   * @param taskId 任务 id。
   * @param configId 配置 id（缺省删除该任务的第一条）。
   * @returns 是否真的删除了条目。
   */
  public delete(taskId: string, configId?: string): boolean {
    const list = this.configs.get(taskId) ?? [];
    const index = configId === undefined ? 0 : list.findIndex((item) => item.id === configId);
    if (index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    if (list.length === 0) this.configs.delete(taskId);
    else this.configs.set(taskId, list);
    return true;
  }

  /**
   * 向任务的全部 webhook 投递一条任务事件（尽力而为，不阻塞调用方等待网络）。
   * @param taskId 任务 id。
   * @param event 任务事件（与流式响应同形）。
   * @returns 无返回值（投递在后台进行）。
   */
  public notify(taskId: string, event: A2aTaskEvent): void {
    for (const config of this.configs.get(taskId) ?? []) {
      void this.post(config, event.payload).catch((error: unknown) => {
        log.warn('a2a.push.failed', {
          taskId,
          configId: config.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * 投递一条 webhook（含 SSRF 字面量拦截与超时）。
   * @param config 目标配置。
   * @param payload 与流式响应同形的载荷。
   * @returns 投递完成（失败抛错，由调用方收敛为日志）。
   */
  private async post(config: A2aPushNotificationConfig, payload: A2aStreamResponse): Promise<void> {
    const verdict = SsrfGuard.inspectUrl(config.url, this.ssrf);
    if (verdict.blocked) {
      log.warn('a2a.push.ssrfBlocked', { url: config.url, reason: verdict.reason });
      return;
    }
    const response = await this.fetchImpl(config.url, {
      method: 'POST',
      headers: A2aPushNotifications.headersOf(config),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      log.warn('a2a.push.httpError', { url: config.url, status: response.status });
    }
  }

  /**
   * 构造 webhook 请求头（内容类型 / 令牌 / 认证）。
   * @param config 目标配置。
   * @returns 请求头。
   */
  private static headersOf(config: A2aPushNotificationConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/a2a+json',
    };
    if (config.token !== undefined && config.token !== '') {
      headers['x-a2a-notification-token'] = config.token;
    }
    const credentials = config.authentication?.credentials;
    if (credentials !== undefined && credentials !== '') {
      const scheme = config.authentication?.schemes?.[0] ?? 'Bearer';
      headers['authorization'] = `${scheme} ${credentials}`;
    }
    return headers;
  }
}
