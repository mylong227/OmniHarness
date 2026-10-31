// 队列模式的协作件（2026-10-31）：队列真相 + 暂停态 + 聊天模式偏好，全部收在这里。
//
// ## 为什么单开一个类
//
// 「在跑回合里再发消息」的三种去向（直接发 / 排队 / 插话）由 `ComposerController.send`
// 决策；而**队列本身**的状态机（FIFO、会话归属、暂停、置顶/删除、续发时机、模式落盘）
// 与"回合怎么跑"无关。把它留在 ComposerController 里会同时顶穿两条铁律：
//   · 单类代码行数（`check.mjs` 的体量口径：codeLines > 500 判上帝类）；
//   · 单一职责（`send` 已经是路由，队列不该再在同一个类里维护数组下标）。
//
// 依赖全部从构造注入（宿主 / 配置写回 / 轻提示 / 是否在飞 / 续发回调），因此本类不 import
// React、RPC 客户端实现或视图层，可在 node 下用桩直测。

import type { AppHost } from './AppController.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import { t } from '../i18n/i18n.ts';
import { ChatMessageQueue, type ImageAttachment, type QueuedMessage } from '../models/ChatMessageQueue.ts';
import { ChatModePreference, type ChatMode } from '../models/ChatModePreference.ts';
import type { FileAttachment } from '../../types/models.ts';

/** ChatQueueController 的依赖（构造注入，测试可全桩）。 */
export interface ChatQueueControllerDeps {
  /** 状态宿主：`queuedMessages` / `queuePaused` / `chatMode` 的快照写到 App 状态。 */
  readonly host: AppHost;
  /** 只用到配置写回（聊天模式落用户级 omniharness.json）。 */
  readonly api: Pick<ApiClient, 'updateConfig'>;
  /** 轻提示出口。 */
  readonly toast: (message: string, kind?: 'ok' | 'err' | 'info') => void;
  /** 是否有回合在飞（在飞时 drain 不发）。 */
  readonly isBusy: () => boolean;
  /** 真正把一条排队消息交给回合执行体（由 ComposerController 注入）。 */
  readonly sendQueued: (message: QueuedMessage) => void;
}

/** 队列坞操作。 */
export type ChatQueueAction = 'remove' | 'promote' | 'clear';

/** 队列模式的协作件：入队 / 续发 / 暂停 / 面板操作 / 模式偏好。 */
export class ChatQueueController {
  /** 构造期注入的依赖（宿主、落盘、提示、在飞判定、续发回调）。 */
  private readonly deps: ChatQueueControllerDeps;
  /** 待发消息（纯逻辑见 models/ChatMessageQueue.ts）。 */
  private readonly queue = new ChatMessageQueue();
  /**
   * 队列是否暂停（用户点「停止」时置位）。
   *
   * 为什么需要：停止后若仍按队列自动续发，用户会看到「刚停下又自己跑起来」——
   * 那等于停止按钮骗人。暂停后由队列坞的「继续」或下一次空闲发送显式恢复。
   */
  private paused = false;

  /**
   * @param deps 宿主 / 落盘 / 提示 / 在飞判定 / 续发回调
   */
  public constructor(deps: ChatQueueControllerDeps) {
    this.deps = deps;
  }

  /**
   * 入队一条消息（队尾；`priority` 为 true 时插到队首）。
   * @param prompt 文本
   * @param images 图像附件
   * @param files 文件附件
   * @param priority 是否插队（插话判定「无关」时用：新任务优先于旧排队项）
   * @returns 无
   */
  public enqueue(
    prompt: string,
    images: ImageAttachment[],
    files: FileAttachment[],
    priority: boolean,
  ): void {
    if (prompt.trim() === '' && images.length + files.length === 0) return;
    const threadId = this.threadId();
    // 用户主动再发一条 = 重新开工：解除「停止」造成的暂停，避免新消息也跟着静默停住。
    this.paused = false;
    this.queue.enqueue({ prompt, images, files, threadId, priority });
    this.sync();
    this.deps.toast(t('已加入队列（{n} 条待发）', { n: this.queue.forThread(threadId).length }), 'info');
  }

  /**
   * 取当前会话的下一条并续发（FIFO）。在飞 / 暂停时不发。
   * @returns 无
   */
  public drain(): void {
    if (this.deps.isBusy() || this.paused) return;
    const next = this.queue.takeNext(this.threadId());
    if (next === null) return;
    this.sync();
    this.deps.sendQueued(next);
  }

  /**
   * 恢复被「停止」暂停的队列并立即续发下一条。
   * @returns 无
   */
  public resume(): void {
    this.paused = false;
    this.sync();
    this.drain();
  }

  /**
   * 队列坞操作：删除 / 置顶 / 清空当前会话。
   * @param action 操作
   * @param id 目标项 id（remove / promote 必填）
   * @returns 无
   */
  public action(action: ChatQueueAction, id?: string): void {
    const threadId = this.threadId();
    if (action === 'clear') this.queue.clear(threadId);
    else if (id !== undefined && action === 'remove') this.queue.remove(id);
    else if (id !== undefined) this.queue.promote(id);
    // 队列被清空后暂停态必须复位：否则下一次入队会「静静地不发」，用户查不出原因。
    if (this.queue.size() === 0) this.paused = false;
    this.sync();
  }

  /**
   * 当前会话是否还有排队项（`send` 用它决定"直接开跑"还是"按队列顺序来"）。
   * @returns 有待发项为 true
   */
  public hasPending(): boolean {
    return this.queue.forThread(this.threadId()).length > 0;
  }

  /**
   * 「停止」时暂停队列（仅在确实有待发项时置位，避免空队列也显示暂停条）。
   * @param threadId 当前会话 id（null=新会话态）
   * @returns 无
   */
  public pauseIfPending(threadId: string | null): void {
    if (this.queue.forThread(threadId).length === 0) return;
    this.paused = true;
    this.sync();
  }

  /**
   * 切换聊天模式：写 App 状态 + localStorage 缓存，并在需要时落盘到用户级配置。
   * @param value 新模式（unknown：来自配置 / 控件，必须窄化）
   * @param persist 是否写回服务端配置（挂载回灌时为 false）
   * @returns 无
   */
  public setMode(value: unknown, persist = true): void {
    const mode: ChatMode = ChatModePreference.parse(value);
    this.deps.host.patch({ chatMode: mode });
    ChatModePreference.write(mode);
    if (!persist) return;
    void this.deps.api.updateConfig({ chatMode: mode }).catch(() => {
      this.deps.toast(t('聊天模式已生效，但保存失败（下次启动会回到上次保存的模式）'), 'err');
    });
  }

  /**
   * 把队列快照写进 App 状态（队列坞渲染的唯一数据源）。
   * @returns 无
   */
  public sync(): void {
    this.deps.host.patch({
      queuedMessages: [...this.queue.all()],
      queuePaused: this.paused,
    });
  }

  /**
   * 当前会话 id（队列归属判定用）。
   * @returns 当前会话 id；新会话态为 null
   */
  private threadId(): string | null {
    return this.deps.host.getState().currentThreadId;
  }
}
