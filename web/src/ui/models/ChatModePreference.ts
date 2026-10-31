/**
 * 聊天模式（2026-10-31，用户需求 A/B）：
 *
 * - `queue`：**队列模式**——任务执行中再发送的消息进入队列，当前任务结束后按顺序逐条发送；
 * - `steer`：**插话模式**——相关/补充/纠正的内容并入当前任务上下文继续执行，完全无关的内容
 *   立即中断当前任务并转入新任务。
 *
 * 归属：这是**跨会话的界面偏好**（设置「常规」页可改），与服务端 `chatMode` 配置键同源；
 * 浏览器另有 localStorage 缓存，供首帧快速恢复（挂载后以服务端配置为准回灌，与 locale 同款）。
 */

/** 聊天模式。 */
export type ChatMode = 'queue' | 'steer';

/** 缺省模式：队列（不打断在跑任务，行为最可预期）。 */
export const DEFAULT_CHAT_MODE: ChatMode = 'queue';

/** localStorage 键（与 omni-locale / omni-theme 同族）。 */
const STORAGE_KEY = 'omni-chat-mode';

/** 聊天模式偏好的读写（localStorage 只做缓存，真源是服务端配置）。 */
export class ChatModePreference {
  /**
   * 把任意输入窄化成合法模式（非法值一律回落缺省，绝不猜）。
   * @param value 待窄化的值（可能来自服务端配置 / localStorage）
   * @returns 合法模式
   */
  public static parse(value: unknown): ChatMode {
    return value === 'steer' ? 'steer' : DEFAULT_CHAT_MODE;
  }

  /**
   * 读取本机缓存的首帧偏好。
   * @returns 合法模式（无缓存 / 存储不可用时为缺省）
   */
  public static read(): ChatMode {
    try {
      return ChatModePreference.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      // 隐私模式 / 非浏览器宿主：读不到就用缺省，不影响后续以服务端配置回灌。
      return DEFAULT_CHAT_MODE;
    }
  }

  /**
   * 写入本机缓存（服务端配置另走 config.update；这里失败不影响模式已生效）。
   * @param mode 目标模式
   * @returns 无
   */
  public static write(mode: ChatMode): void {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 忽略：存储不可用时仅本次会话生效 */
    }
  }

  /**
   * 模式的中文/英文展示名（设置页与队列坞共用，避免两处措辞漂移）。
   * @param mode 模式
   * @returns 展示名（供 t() 词条命中）
   */
  public static labelOf(mode: ChatMode): string {
    return mode === 'steer' ? '插话模式' : '队列模式';
  }
}
