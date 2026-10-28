/**
 * 工具 → 资源域绑定（**单一来源**，2026-10-28 BLOCKERS §5 收口）。
 *
 * 工具名常量的消费口径见 `toolNames.ts`（新增工具先在那里登记）；本表回答的是
 * 「这个工具执行时要独占/共享哪些**进程级宿主资源**」。未登记的工具不持任何域锁
 * （文件争抢走 workspaceFileCoordinator 的按路径锁，shell 走公平闸门——各归其位）。
 *
 * 收录判据：**多个会话并发执行会互相踩踏的宿主资源**才登记。当前唯一实例是
 * `BrowserSession`（跨调用复用同一浏览器实例，跨会话并发会互踩标签页）。
 */
import { TOOL_NAMES } from './toolNames.ts';

/** 一条工具→资源域绑定。 */
export interface ToolResourceDomainBinding {
  /** 域名（跨会话互斥的键）。 */
  readonly domain: string;
  /** 锁模式：`write` = 互斥；`read` = 共享（多读者并行）。 */
  readonly mode: 'read' | 'write';
}

/** 工具名 → 域绑定表（未登记的工具不持锁；纯数据——查询口在消费方 core）。 */
export const TOOL_RESOURCE_DOMAINS: Readonly<Record<string, readonly ToolResourceDomainBinding[]>> =
  {
    // 浏览器两工具共用一个跨调用复用的 BrowserSession：跨会话并发会互踩同一标签页
    // （A navigate 与 B screenshot 交错 ⇒ B 截到 A 的页面）。写锁跨会话串行。
    [TOOL_NAMES.browserAct]: [{ domain: 'browser', mode: 'write' }],
    [TOOL_NAMES.browserScreenshot]: [{ domain: 'browser', mode: 'write' }],
  };
