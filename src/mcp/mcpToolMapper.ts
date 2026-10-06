import type { ToolDefinition } from '../ports/tool/tool.js';
import type { McpInputSchema, McpToolDescriptor } from './mcpProtocol.js';

/** 提示注入指令特征（英文 + 中文，聚焦无歧义短语，降低对正常工具描述的误伤）。 */
const MCP_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all|the|previous|prior|above|earlier)\s+(instructions?|prompts?|context|messages)/i,
  /disregard\s+(the\s+)?(above|previous|prior|instructions?|context)/i,
  /forget\s+(everything|all|your|previous|prior)\s*(instructions?|prompts?|context)?/i,
  /you\s+are\s+now\s+(a|an|my|the)\s+(new|different|uncensored|jailbroken|ai|assistant|model|bot|agent)/i,
  /new\s+instructions?/i,
  /override\s+(the\s+)?(previous|all|my)\s+instructions?/i,
  /忽略\s*(以上|之前|先前|前面的|所有|全部|上文)\s*(指令|提示|要求|上下文|规则)/,
  /无视\s*(以上|之前|先前|前面的|所有|全部)\s*(指令|提示|要求|上下文|规则)/,
  /忘记\s*(之前|以前|所有|全部|上文)\s*(指令|提示|要求|上下文)/,
  /新的\s*指令/,
];

/**
 * @beta
 * 工具定义 ↔ MCP 工具描述映射（两种协议同构，仅做结构规整）。
 *
 * 提示注入扫描（fail-closed 防御纵深）：外部 MCP 服务器工具描述会被桥接进本地工具注册表，
 * 进而进入 agent 上下文。若描述含提示注入指令（诱导模型忽略既有指令、切换角色等），会污染
 * 本地 agent 决策。两个方向（本地→MCP / MCP→本地）的 description 都扫描，命中即抛错拒绝透传。
 * 注：这是启发式纵深防御（非硬性安全边界），聚焦无歧义的注入指令短语，避免误伤正常描述。
 */
export class McpToolMapper {
  /**
   * 扫描工具 description 是否含提示注入特征（两个桥接方向共用，fail-closed 防御纵深）。
   * 外部 MCP 服务器工具描述会被桥接进本地工具注册表与 agent 上下文；若描述含诱导模型
   * 忽略既有指令、切换角色等无歧义注入指令短语，则拒绝透传。
   * @param description 待扫描的工具描述文本
   * @returns 无返回值（命中注入特征则抛错）
   */
  public static scanToolDescription(description: string): void {
    for (const pattern of MCP_INJECTION_PATTERNS) {
      const hit = pattern.exec(description);
      if (hit !== null) {
        throw new Error(
          `工具 description 含提示注入特征，拒绝透传（匹配片段: ${hit[0].slice(0, 40)}）`,
        );
      }
    }
  }

  /** 本地工具定义 → MCP 描述（description 经提示注入扫描，命中即拒绝透传）。 */
  public toDescriptor(definition: ToolDefinition): McpToolDescriptor {
    McpToolMapper.scanToolDescription(definition.description);
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: this.toInputSchema(definition),
    };
  }

  /** MCP 描述 → 本地工具定义（description 经提示注入扫描，命中即拒绝透传）。 */
  public toDefinition(descriptor: McpToolDescriptor): ToolDefinition {
    McpToolMapper.scanToolDescription(descriptor.description);
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
  private toInputSchema(definition: ToolDefinition): McpInputSchema {
    return {
      type: 'object',
      properties: definition.parameters.properties,
      required: definition.parameters.required ?? [],
    };
  }
}

/** 默认实例（无状态、可并发复用，调用点以 `mcpToolMapper.xxx` 零构造复用）。 */
export const mcpToolMapper = new McpToolMapper();
