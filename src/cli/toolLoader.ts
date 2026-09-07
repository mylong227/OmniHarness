import { pathToFileURL } from 'node:url';
import type { ToolDefinition, ToolPort } from '../ports/tool.js';
import type { ExtraTool } from '../config/omniharnessConfig.js';

/** 自定义工具加载器：从模块文件加载定制工具（定制接入专用插口）。 */
export class ToolLoader {
  /** 加载一个工具模块（默认导出 ToolPort 或 { definition, handler }）。 */
  static async load(filePath: string): Promise<ExtraTool | ToolPort> {
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

  /** 是否为 ToolPort。 */
  private static isToolPort(value: unknown): value is ToolPort {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ToolPort>;
    return typeof candidate.list === 'function' && typeof candidate.execute === 'function';
  }

  /** 是否为 ExtraTool。 */
  private static isExtraTool(value: unknown): value is ExtraTool {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ExtraTool>;
    return this.isDefinition(candidate.definition) && typeof candidate.handler === 'function';
  }

  /** 是否为工具定义。 */
  private static isDefinition(value: unknown): value is ToolDefinition {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<ToolDefinition>;
    return typeof candidate.name === 'string' && typeof candidate.description === 'string';
  }
}
