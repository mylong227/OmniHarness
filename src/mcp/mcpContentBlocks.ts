import type { McpContentBlock } from '../ports/mcp/mcpProtocolTypes.js';

/**
 * MCP 内容块的**归一化**（G10/T3，2026-10-03 第十五轮）。
 *
 * ## 为什么必须收成一处
 *
 * 本仓有**两个** MCP 客户端实现（官方 SDK 适配器 `sdkMcpClientAdapter` 与手写回退 `mcpClient`），
 * 而"非文本块怎么转述"这件事此前在两处**各写一半**：
 *  - SDK 适配器把非文本块收敛为 `{type:'text', text:''}`（**静默丢块**）；
 *  - 手写实现原样透传原始块，但网关只读 `.text` ⇒ 结果里同样是**空段**。
 * 两份映射一旦漂移，同一条远端响应在两条路径下会给出不同文本——这正是本仓反复治的"实现分叉且不报错"。
 * 故把映射收进本类，两条路径共用。
 *
 * ## 口径
 *
 *  - 文本块：原样保留（`text` 可能为空串，那是远端自己给的）；
 *  - 图 / 音：转述为含 **MIME 与体积**的可读文本 + 保留原始块；
 *  - 资源链接 / 内嵌资源：转述为含 **URI/名称**的可读文本 + 保留原始块；
 *  - 未建模形状：转述为 **JSON 摘要**（截断 200 字符）——**绝不返回空串**。
 */
export class McpContentBlocks {
  /**
   * 归一化单个内容块（不可信输入：形状未知，绝不自造语义、绝不抛错）。
   * @param entry 远端返回的内容块。
   * @returns 本仓内容块（文本或保真转述）。
   */
  public static normalize(entry: unknown): McpContentBlock {
    const record = entry as { readonly type?: unknown; readonly text?: unknown };
    if (record.type === 'text' || typeof record.text === 'string') {
      return { type: 'text', text: typeof record.text === 'string' ? record.text : '' };
    }
    const rich = entry as {
      readonly type?: unknown;
      readonly mimeType?: unknown;
      readonly data?: unknown;
      readonly uri?: unknown;
      readonly name?: unknown;
      readonly resource?: unknown;
    };
    const type = typeof rich.type === 'string' ? rich.type : '';
    const mime = typeof rich.mimeType === 'string' ? rich.mimeType : '未知类型';
    switch (type) {
      case 'image':
      case 'audio': {
        const bytes =
          typeof rich.data === 'string'
            ? `${String(Math.ceil(rich.data.length / 4) * 3)} 字节 base64`
            : '无内联数据';
        const label = type === 'image' ? '图片' : '音频';
        return {
          type,
          text: `[${label}：${mime}，${bytes}（本仓工具结果通道只承载文本，原始块已保留）]`,
          raw: entry,
        };
      }
      case 'resource_link': {
        const uri = typeof rich.uri === 'string' ? rich.uri : '(无 URI)';
        const name = typeof rich.name === 'string' ? `${rich.name} ` : '';
        return { type: 'resource_link', text: `[资源链接：${name}${uri}]`, raw: entry };
      }
      case 'resource': {
        const inner = rich.resource as { uri?: unknown } | undefined;
        const uri = typeof inner?.uri === 'string' ? inner.uri : '(内嵌资源)';
        return { type: 'resource', text: `[内嵌资源：${uri}]`, raw: entry };
      }
      default: {
        let summary: string;
        try {
          summary = JSON.stringify(entry) ?? String(entry);
        } catch {
          summary = String(entry);
        }
        const suffix = type === '' ? '' : `（${type}）`;
        return {
          type: 'unknown',
          text: `[未建模内容块${suffix}：${summary.slice(0, 200)}]`,
          raw: entry,
        };
      }
    }
  }

  /**
   * 归一化内容块数组（形状未知 ⇒ 非数组视为空；单项坏掉也不会拖垮整批）。
   * @param entries 远端返回的内容块数组（未知）。
   * @returns 归一化后的内容块列表。
   */
  public static normalizeAll(entries: unknown): readonly McpContentBlock[] {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.map((entry) => McpContentBlocks.normalize(entry));
  }
}
