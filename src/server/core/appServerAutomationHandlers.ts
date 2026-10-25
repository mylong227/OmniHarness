/** 自动化 RPC 处理器（从 AppServer 抽出，避免其代码行数继续增长）。 */
import type { AutomationStore } from '../services/automationStore.ts';

/** RPC 方法表类型（与 AppServerBase.handlers 同形）。 */
type HandlerMap = Map<string, (params: Record<string, unknown>) => Promise<unknown>>;

/** 自动化任务 RPC。 */
export class AppServerAutomationHandlers {
  /**
   * @param store 任务存储（缺省未接线）
   * @param createThread 触发时新建会话
   */
  public constructor(
    /** 任务存储（缺省未接线）。 */
    private readonly store: AutomationStore | undefined,
    /** 触发时新建会话。 */
    private readonly createThread: (params: Record<string, unknown>) => Promise<unknown>,
  ) {}

  /**
   * 注册 automations.* 方法。
   * @param handlers 方法表
   * @returns 无返回值
   */
  public register(handlers: HandlerMap): void {
    handlers.set('automations.list', () => Promise.resolve(this.store?.list() ?? []));
    handlers.set('automations.create', (params) =>
      Promise.resolve(this.requireStore().create(params)),
    );
    handlers.set('automations.delete', (params) =>
      Promise.resolve(this.requireStore().delete(String(params['id'] ?? ''))),
    );
    handlers.set('automations.setEnabled', (params) => {
      const id = String(params['id'] ?? '');
      return Promise.resolve(this.requireStore().setEnabled(id, params['enabled'] === true));
    });
    handlers.set('automations.run', async (params) => {
      const store = this.requireStore();
      const id = String(params['id'] ?? '');
      const automation = store.get(id);
      if (automation === undefined) throw new Error('自动化不存在');
      const result = await this.createThread({ prompt: automation.prompt });
      store.markRun(id);
      return result;
    });
  }

  /**
   * 取存储；未注入时 fail-closed。
   * @returns 存储
   */
  private requireStore(): AutomationStore {
    if (this.store === undefined) throw new Error('自动化未接线');
    return this.store;
  }
}
