import type { ToolDefinition } from '../ports/tool.js';
import type { McpInputSchema, McpToolDescriptor } from './mcpProtocol.js';

/**
 * @beta
 * 工具定义 ↔ MCP 工具描述映射（两种协议同构，仅做结构规整）。
 */
export class McpToolMapper {
  /** 本地工具定义 → MCP 描述。 */
  public static toDescriptor(definition: ToolDefinition): McpToolDescriptor {
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: McpToolMapper.toInputSchema(definition),
    };
  }

  /** MCP 描述 → 本地工具定义（可直接注册进 RegistryToolPort）。 */
  public static toDefinition(descriptor: McpToolDescriptor): ToolDefinition {
    return {
      name: descriptor.name,
      description: descriptor.description,
      parameters: {
        type: 'object',
        properties: descriptor.inputSchema.properties ?? {},
        required: descriptor.inputSchema.required ?? [],
      },
    };
  }

  /** 参数 schema → MCP 输入 schema。 */
  private static toInputSchema(definition: ToolDefinition): McpInputSchema {
    return {
      type: 'object',
      properties: definition.parameters.properties,
      required: definition.parameters.required ?? [],
    };
  }
}
