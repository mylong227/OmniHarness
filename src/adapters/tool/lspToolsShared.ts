import type { ToolCall } from '../../ports/tool/tool.js';
import type { LspLocation } from '../../ports/tool/lsp.js';

/** 把文件+1-based 区间渲染成编辑器友好的一行定位（file:line:col）。 */
export function renderLocation(loc: LspLocation): string {
  const { start } = loc.range;
  return `${loc.uri}:${start.line}:${start.character}`;
}

/** 校验并提取 file / line / character（1-based 编辑器坐标）。 */
export function parseTarget(
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
