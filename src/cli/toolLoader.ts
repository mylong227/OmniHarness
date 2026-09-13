import { pathToFileURL } from 'node:url';
import type { ToolDefinition, ToolPort } from '../ports/tool/tool.js';
import type { ExtraTool } from '../config/configFactory.js';

/**
 * 自定义工具加载器：从模块文件加载定制工具（定制接入专用插口）。
 *
 * 无状态、无 IO 状态：同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class ToolLoader {
  /**
   * 加载一个工具模块（默认导出 ToolPort 或 { definition, handler }）。
   * @param filePath 工具模块文件路径（ESM 动态 import 加载）。
   * @returns 加载出的完整工具端口或「定义 + 处理器」组合；导出形态非法时抛错。
   */
  public async load(filePath: string): Promise<ExtraTool | ToolPort> {
    const module = await import(pathToFileURL(filePath).href);
    const exported = module.default;
    if (this.isToolPort(exported)) {
      return exported;
    }
    if (this.isExtraTool(exported)) {
      return exported;
    }
    throw new Error(
      `自定义工具模块无效（需导出 ToolPort 或 { definition, handler }）: ${filePath}`,
    );
  }

  /**
   * 是否为 ToolPort。
   * @param value 待判定的模块默认导出。
   * @returns 同时具备 list / execute 函数成员时为 true（类型守卫收窄）。
   */
  private isToolPort(value: unknown): value is ToolPort {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ToolPort>;
    return typeof candidate.list === 'function' && typeof candidate.execute === 'function';
  }

  /**
   * 是否为 ExtraTool。
   * @param value 待判定的模块默认导出。
   * @returns 具备合法 definition 与 handler 函数时为 true（类型守卫收窄）。
   */
  private isExtraTool(value: unknown): value is ExtraTool {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ExtraTool>;
    return this.isDefinition(candidate.definition) && typeof candidate.handler === 'function';
  }

  /**
   * 是否为工具定义。
   * @param value 待判定的对象。
   * @returns name / description 均为字符串时为 true（类型守卫收窄）。
   */
  private isDefinition(value: unknown): value is ToolDefinition {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ToolDefinition>;
    return typeof candidate.name === 'string' && typeof candidate.description === 'string';
  }
}

// ---- 门面兼容：委托默认实例，导出名与签名不变 ----
const toolLoader = new ToolLoader();

/**
 * 加载一个工具模块（默认导出 ToolPort 或 { definition, handler }）。
 * @param filePath 工具模块文件路径。
 * @returns 加载出的工具（形态非法时抛错）。
 */
export async function loadToolModule(filePath: string): Promise<ExtraTool | ToolPort> {
  return toolLoader.load(filePath);
}
