// 聊天消息队列（2026-10-31「队列模式」的纯逻辑层）。
//
// ## 为什么单独成模
//
// 队列的行为（按会话归属、FIFO、置顶、删除、暂停、下一条）全是**纯数据运算**，与 React /
// RPC 无关。把它抽出来后：
//   · 控制器只负责"什么时候取一条发出去"（时序），不碰数组下标；
//   · 队列坞只负责渲染快照，不持有真相；
//   · 可以在 node 环境里穷举边界（见 web/test/chatQueue.test.ts）。
//
// ## 归属语义
//
// 队列入队时记下**当时的会话 id**（`threadId: null` 表示"会话尚未创建"）。只有当前会话
// 匹配的项才会被发送：否则在 A 会话排队的消息会在用户切到 B 后被发进 B——那是数据串台。
// `null` 的项视为"任何会话都可发"（首条消息建会话的场景）。

import type { FileAttachment } from '../../types/models.ts';
import { extractUrls } from '../textUtils.ts';
import { t } from '../i18n/i18n.ts';
import type { ChatMode } from './ChatModePreference.ts';

/** 图像内容（与 turns.run 的 images 同构）。 */
export interface ImageAttachment {
  /** http(s) / data URI（与 data 二选一）。 */
  url?: string;
  /** base64（不含 data: 前缀）。 */
  data?: string;
  /** MIME 类型。 */
  mediaType?: string;
}

/** 队列里的一条消息（与一次 onSend 的入参同构，外加归属与元信息）。 */
export interface QueuedMessage {
  /** 队列内唯一 id（渲染 key / 删除 / 置顶都用它）。 */
  readonly id: string;
  /** 文本内容（可为空串：纯附件消息）。 */
  readonly prompt: string;
  /** 图片/视频/GIF 等图像内容。 */
  readonly images: readonly ImageAttachment[];
  /** 任意文件附件。 */
  readonly files: readonly FileAttachment[];
  /** 入队时的会话 id（null=会话尚未创建）。 */
  readonly threadId: string | null;
  /** 入队时刻（ms）。 */
  readonly createdAt: number;
  /** 是否插队（插话模式判定"无关"时排到队首，优先于还在排队的旧消息）。 */
  readonly priority: boolean;
}

/** 入队入参。 */
export interface EnqueueInput {
  /** 文本内容。 */
  readonly prompt: string;
  /** 图像内容。 */
  readonly images: readonly ImageAttachment[];
  /** 文件附件。 */
  readonly files: readonly FileAttachment[];
  /** 提交时的会话 id（null=尚未创建）。 */
  readonly threadId: string | null;
  /** 是否插队（默认 false）。 */
  readonly priority?: boolean;
}

/** 队列坞的一个附件视图。 */
export interface QueueAttachmentView {
  /** 渲染 key。 */
  readonly key: string;
  /** 展示名（文件名或 MIME 推断名）。 */
  readonly name: string;
  /** MIME。 */
  readonly mediaType: string;
  /** 预览种类：图片/视频走缩略图，其余走文件图标。 */
  readonly kind: 'image' | 'video' | 'file';
  /** 缩略图地址（图片/视频且拿得到数据时）。 */
  readonly previewUrl?: string;
}

/**
 * 队列坞的视图契约（App 组装、Composer 渲染）。
 *
 * 收成一个对象而不是十几个 props，是为了让 Composer 的 JSX 只多一行——组件函数体有
 * 行数基线（check.mjs），逐个透传会把基线顶穿。
 */
export interface ChatQueueView {
  /** 当前聊天模式（决定队列坞标题与发送按钮文案）。 */
  readonly mode: ChatMode;
  /** 当前会话排队中的消息（第一条=下一条将要发送的）。 */
  readonly items: readonly QueuedMessage[];
  /** 队列是否因用户点「停止」而暂停（暂停时不会自动续发）。 */
  readonly paused: boolean;
  /** 当前是否有回合在跑（文案用）。 */
  readonly busy: boolean;
  /** 删除一条。 */
  readonly onRemove: (id: string) => void;
  /** 置顶一条。 */
  readonly onPromote: (id: string) => void;
  /** 清空当前会话的排队。 */
  readonly onClear: () => void;
  /** 继续发送（暂停后恢复）。 */
  readonly onResume: () => void;
}

/** 消息队列（纯内存，进程内唯一实例由 ComposerController 持有）。 */
export class ChatMessageQueue {
  /** 当前队列（按入队顺序）。 */
  private items: QueuedMessage[] = [];
  /** id 自增序号（同一毫秒内入队多条也不撞 key）。 */
  private seq = 0;

  /**
   * 入队一条消息。
   * @param input 消息内容与会话归属
   * @param now 入队时刻（测试可注入固定值）
   * @returns 新入队的项
   */
  public enqueue(input: EnqueueInput, now = Date.now()): QueuedMessage {
    this.seq += 1;
    const item: QueuedMessage = {
      id: 'q' + String(this.seq) + '-' + now.toString(36),
      prompt: input.prompt,
      images: [...input.images],
      files: [...input.files],
      threadId: input.threadId,
      createdAt: now,
      priority: input.priority === true,
    };
    if (item.priority) this.items.unshift(item);
    else this.items.push(item);
    return item;
  }

  /**
   * 队列全量快照（新数组：调用方可安全交给 React 状态）。
   * @returns 队列项（不暴露内部数组引用）
   */
  public all(): readonly QueuedMessage[] {
    return [...this.items];
  }

  /**
   * 当前会话可见的队列项（`threadId: null` 的项对所有会话可见）。
   * @param threadId 当前会话 id（null=新会话态）
   * @returns 过滤后的队列项
   */
  public forThread(threadId: string | null): readonly QueuedMessage[] {
    return this.items.filter((item) => ChatMessageQueue.belongsTo(item, threadId));
  }

  /**
   * 取出当前会话的下一条（FIFO，队首优先）并从队列移除。
   * @param threadId 当前会话 id（null=新会话态）
   * @returns 下一条；无匹配项时 null
   */
  public takeNext(threadId: string | null): QueuedMessage | null {
    const index = this.items.findIndex((item) => ChatMessageQueue.belongsTo(item, threadId));
    if (index < 0) return null;
    const [next] = this.items.splice(index, 1);
    return next ?? null;
  }

  /**
   * 删除一条。
   * @param id 队列项 id
   * @returns 是否真的删掉了
   */
  public remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return this.items.length !== before;
  }

  /**
   * 置顶一条（移到所属会话可发项的最前面）。
   * @param id 队列项 id
   * @returns 是否找到并移动
   */
  public promote(id: string): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index <= 0) return index === 0;
    const [item] = this.items.splice(index, 1);
    if (item === undefined) return false;
    this.items.unshift(item);
    return true;
  }

  /**
   * 清空当前会话的排队项（不动其它会话的队列）。
   * @param threadId 当前会话 id（null=新会话态）
   * @returns 清掉的条数
   */
  public clear(threadId: string | null): number {
    const before = this.items.length;
    this.items = this.items.filter((item) => !ChatMessageQueue.belongsTo(item, threadId));
    return before - this.items.length;
  }

  /**
   * 队列是否为空。
   * @returns 无排队项为 true
   */
  public isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * 总条数（含其它会话；观测用）。
   * @returns 条数
   */
  public size(): number {
    return this.items.length;
  }

  /**
   * 该项是否属于给定会话（null 项对所有会话可发）。
   * @param item 队列项
   * @param threadId 当前会话 id
   * @returns 可发为 true
   */
  private static belongsTo(item: QueuedMessage, threadId: string | null): boolean {
    if (item.threadId === null) return true;
    return threadId !== null && item.threadId === threadId;
  }
}

/** 队列项的展示派生（文本 / 附件 / 链接），组件与测试共用。 */
export class ChatQueuePreview {
  /**
   * 一句话摘要（供折叠态 / 通知 / title）。
   * @param item 队列项
   * @returns 有文本用文本，纯附件用占位文案
   */
  public static summaryOf(item: QueuedMessage): string {
    const text = item.prompt.trim().replace(/\s+/g, ' ');
    if (text !== '') return text;
    const count = item.images.length + item.files.length;
    return count > 0 ? t('（仅附件，共 {n} 个）', { n: count }) : t('（空消息）');
  }

  /**
   * 附件视图（缩略图 / 文件图标所需的最小信息）。
   * @param item 队列项
   * @returns 附件视图数组（顺序：先图片视频，再文件）
   */
  public static attachmentsOf(item: QueuedMessage): QueueAttachmentView[] {
    const out: QueueAttachmentView[] = [];
    item.images.forEach((image, index) => {
      const mediaType = image.mediaType ?? '';
      out.push({
        key: 'i' + index,
        name: ChatQueuePreview.nameOf(image, index, 'image'),
        mediaType,
        kind: mediaType.toLowerCase().startsWith('video/') ? 'video' : 'image',
        previewUrl: ChatQueuePreview.dataUrlOf(image),
      });
    });
    item.files.forEach((file, index) => {
      const mediaType = file.mediaType ?? '';
      const lower = mediaType.toLowerCase();
      const couldPreview = lower.startsWith('image/') || lower.startsWith('video/');
      out.push({
        key: 'f' + index,
        name: file.name,
        mediaType,
        kind: lower.startsWith('video/') ? 'video' : lower.startsWith('image/') ? 'image' : 'file',
        ...(couldPreview ? { previewUrl: ChatQueuePreview.dataUrlOf(file) } : {}),
      });
    });
    return out;
  }

  /**
   * 文本里的外链（渲染成可点击入口，不改变发送内容）。
   * @param item 队列项
   * @returns URL 数组（去重、按出现顺序）
   */
  public static linksOf(item: QueuedMessage): string[] {
    return extractUrls(item.prompt);
  }

  /**
   * 附件个数（折叠态徽标）。
   * @param item 队列项
   * @returns 总个数
   */
  public static countOf(item: QueuedMessage): number {
    return item.images.length + item.files.length;
  }

  /**
   * 取附件的数据 URL（url 优先；否则用 data + mediaType 拼）。
   * @param attachment 图片或文件附件
   * @returns data/http URL；拿不到返回 undefined
   */
  private static dataUrlOf(attachment: ImageAttachment | FileAttachment): string | undefined {
    if (typeof attachment.url === 'string' && attachment.url !== '') return attachment.url;
    const mediaType = attachment.mediaType ?? '';
    if (typeof attachment.data === 'string' && attachment.data !== '' && mediaType !== '') {
      return 'data:' + mediaType + ';base64,' + attachment.data;
    }
    return undefined;
  }

  /**
   * 附件展示名（图像内容常只有 mediaType）。
   * @param attachment 图像附件
   * @param index 下标
   * @param fallback 兜底名
   * @returns 展示名
   */
  private static nameOf(
    attachment: ImageAttachment,
    index: number,
    fallback: string,
  ): string {
    const mediaType = (attachment.mediaType ?? '').toLowerCase();
    const ext = mediaType.includes('/') ? mediaType.split('/')[1] ?? '' : '';
    return (ext === '' ? fallback : ext) + ' ' + String(index + 1);
  }
}
