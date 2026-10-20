/**
 * 浏览器动作端口（ACT-01，2026-10-20）。
 *
 * 为什么单独成端口：`browser_screenshot` 只证明“页面能渲染”，不证明“页面能操作”。
 * 前端任务需要点击/输入/滚动/读取可访问性树/看 console 与失败网络请求；把动作面
 * 抽成端口，工具层只做参数校验与审批分类，执行体可注入假实现做离线判据。
 */

/** 支持的动作类型。 */
export type BrowserActionKind =
  | 'goto'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'wait_for'
  | 'aria_snapshot'
  | 'console'
  | 'network';

/** 一次浏览器动作请求（参数由工具层校验/夹紧）。 */
export interface BrowserActionRequest {
  /** 动作类型。 */
  readonly kind: BrowserActionKind;
  /** `goto` 的目标地址（http/https/data）。 */
  readonly url?: string | undefined;
  /** CSS 选择器（click/type/wait_for）。 */
  readonly selector?: string | undefined;
  /** 要输入的文本（type）。 */
  readonly text?: string | undefined;
  /** 按键名（press：Enter/Tab/Escape/Backspace/ArrowUp/...）。 */
  readonly key?: string | undefined;
  /** 滚动增量（scroll，像素）。 */
  readonly dx?: number | undefined;
  readonly dy?: number | undefined;
  /** 等待超时（wait_for，毫秒）。 */
  readonly timeoutMs?: number | undefined;
}

/** 动作结果。 */
export interface BrowserActionResult {
  /** 是否成功执行（选择器不存在等可恢复失败为 false + 可读原因）。 */
  readonly ok: boolean;
  /** 给模型看的结果文本（短、可行动）。 */
  readonly output: string;
}

/** 浏览器动作端口。 */
export interface BrowserActionPort {
  /** 执行一个动作。 */
  act(request: BrowserActionRequest): Promise<BrowserActionResult>;
}
