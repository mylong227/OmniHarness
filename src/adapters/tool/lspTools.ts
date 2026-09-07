import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { LspLocation, LspPort } from '../../ports/lsp.js';
import {
  LSP_FIND_REFERENCES_TOOL_NAME,
  LSP_GO_TO_DEFINITION_TOOL_NAME,
  LSP_HOVER_TOOL_NAME,
  LSP_STATUS_TOOL_NAME,
} from '../../lsp/lspToolNames.js';

/** 把文件+1-based 区间渲染成编辑器友好的一行定位（file:line:col）。 */
function renderLocation(loc: LspLocation): string {
  const { start } = loc.range;
  return `${loc.uri}:${start.line}:${start.character}`;
}

/** 校验并提取 file / line / character（1-based 编辑器坐标）。 */
function parseTarget(
  call: ToolCall,
): { file: string; line: number; character: number } | { readonly error: string } {
  const file = String(call.arguments['file'] ?? '').trim();
  if (file === '') {
    return { error: '缺少文件参数: file' };
  }
  const line = Number(call.arguments['line']);
  const character = Number(call.arguments['character']);
  if (!Number.isInteger(line) || line < 1) {
    return { error: 'line 必须是 >=1 的整数（编辑器行号）' };
  }
  if (!Number.isInteger(character) || character < 1) {
    return { error: 'character 必须是 >=1 的整数（编辑器列号）' };
  }
  return { file, line, character };
}

/**
 * @beta
 * 模型面工具：跳转到符号定义。
 */
export class LspGoToDefinitionTool {
  readonly definition: ToolDefinition = {
    name: LSP_GO_TO_DEFINITION_TOOL_NAME,
    description:
      '跳转到光标处符号的定义位置（需已配置 LSP 服务器，如 typescript-language-server）。返回 0..n 个 file:line:col 定位。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
        line: { type: 'number', description: '行号（>=1，编辑器行号）。' },
        character: { type: 'number', description: '列号（>=1，编辑器列号）。' },
      },
      required: ['file', 'line', 'character'],
    },
  };

  constructor(private readonly lsp: LspPort) {}

  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const target = parseTarget(call);
    if ('error' in target) {
      return { callId: call.id, ok: false, error: target.error };
    }
    try {
      const locs = await this.lsp.definition(target.file, target.line, target.character);
      if (locs.length === 0) {
        return { callId: call.id, ok: true, output: '未找到定义' };
      }
      return { callId: call.id, ok: true, output: locs.map(renderLocation).join('\n') };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 跳转定义失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/**
 * @beta
 * 模型面工具：查找符号的全部引用。
 */
export class LspFindReferencesTool {
  readonly definition: ToolDefinition = {
    name: LSP_FIND_REFERENCES_TOOL_NAME,
    description:
      '查找光标处符号的全部引用位置（需已配置 LSP 服务器）。返回 file:line:col 定位列表（含声明处）。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
        line: { type: 'number', description: '行号（>=1，编辑器行号）。' },
        character: { type: 'number', description: '列号（>=1，编辑器列号）。' },
      },
      required: ['file', 'line', 'character'],
    },
  };

  constructor(private readonly lsp: LspPort) {}

  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const target = parseTarget(call);
    if ('error' in target) {
      return { callId: call.id, ok: false, error: target.error };
    }
    try {
      const locs = await this.lsp.references(target.file, target.line, target.character);
      if (locs.length === 0) {
        return { callId: call.id, ok: true, output: '未找到引用' };
      }
      return { callId: call.id, ok: true, output: locs.map(renderLocation).join('\n') };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 查找引用失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/**
 * @beta
 * 模型面工具：悬停文档。
 */
export class LspHoverTool {
  readonly definition: ToolDefinition = {
    name: LSP_HOVER_TOOL_NAME,
    description:
      '获取光标处符号的悬停文档（类型签名/注释，需已配置 LSP 服务器）。返回文档文本，无则提示无文档。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '目标文件的绝对路径。' },
        line: { type: 'number', description: '行号（>=1，编辑器行号）。' },
        character: { type: 'number', description: '列号（>=1，编辑器列号）。' },
      },
      required: ['file', 'line', 'character'],
    },
  };

  constructor(private readonly lsp: LspPort) {}

  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const target = parseTarget(call);
    if ('error' in target) {
      return { callId: call.id, ok: false, error: target.error };
    }
    try {
      const doc = await this.lsp.hover(target.file, target.line, target.character);
      return { callId: call.id, ok: true, output: doc ?? '无悬停文档' };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `LSP 悬停失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/**
 * @beta
 * 模型面工具：LSP 状态自查（服务器名 + 就绪）。
 */
export class LspStatusTool {
  readonly definition: ToolDefinition = {
    name: LSP_STATUS_TOOL_NAME,
    description:
      '查看 LSP 代码导航是否就绪：返回后端名与可用性，便于在调用跳转/引用前确认已配置语言服务器。',
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  constructor(private readonly lsp: LspPort) {}

  async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    return { callId: call.id, ok: true, output: `LSP 代码导航可用｜后端: ${this.lsp.name}` };
  }
}
