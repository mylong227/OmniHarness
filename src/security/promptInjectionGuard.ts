/**
 * 确定性提示注入护栏（零依赖，实验性 @beta）。
 *
 * 仅做基于规则的启发式扫描（不引入 ML / 外部服务），用于 opt-in 拦截工具结果 /
 * 外部内容里疑似「指令注入」的片段，避免其直接进入模型上下文。
 * 默认关闭：仅当 config.promptInjectionGuard === true 时由 StepRunner 调用。
 * fail-closed：护栏一旦启用，扫描器自身抛错时**保守拦截**（不把原始结果放行进上下文）。
 */

import type { ToolResult } from '../ports/tool.js';

export interface InjectionHit {
  /** 命中规则的正则源（用于可观测 / 审计）。 */
  readonly pattern: string;
  /** 命中片段（截断，避免把注入内容原样回显）。 */
  readonly snippet: string;
}

export interface InjectionScan {
  /** 是否判定为注入（命中任意高危规则即 true，保守策略）。 */
  readonly blocked: boolean;
  /** 命中规则数。 */
  readonly score: number;
  /** 命中的规则明细。 */
  readonly hits: readonly InjectionHit[];
}

/** 高危指令 / 角色伪造规则（零依赖正则；按需增删即可）。 */
const DIRECTIVES: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts?|context)/i,
  /disregard\s+(?:previous|prior|above|earlier)\s+/i,
  /forget\s+(?:everything|all\s+(?:previous|prior))\s+/i,
  /you\s+are\s+now\s+[a-z][a-z\s]{0,24}/i,
  /(?:^|\n)\s*system\s*:\s*/i,
  /(?:^|\n)\s*assistant\s*:\s*/i,
  /\[\s*SYS(?:TEM)?\s*\]/i,
  /<\s*system\s*>/i,
  /<\s*assistant\s*>/i,
  /do\s+not\s+tell\s+(?:the\s+)?user/i,
  /reveal\s+your\s+(?:instructions|prompt|system\s+prompt|configuration)/i,
  /override\s+(?:your|the)\s+(?:instructions|guidelines|rules|system)/i,
  /new\s+instructions?\s*:/i,
  /pretend\s+to\s+be\s+/i,
  /act\s+as\s+(?:a|an)\s+[a-z][a-z\s]{0,24}/i,
  /execute\s+the\s+following\s+(?:command|instructions?)\s*:/i,
];

/** 扫描文本，返回命中明细（保守：任意高危规则命中即 blocked）。 */
export function scanForInjection(text: string): InjectionScan {
  if (text.length === 0) {
    return { blocked: false, score: 0, hits: [] };
  }
  try {
    const hits: InjectionHit[] = [];
    for (const re of DIRECTIVES) {
      const m = re.exec(text);
      if (m !== null) {
        hits.push({ pattern: re.source, snippet: m[0].slice(0, 64) });
      }
    }
    return { blocked: hits.length > 0, score: hits.length, hits };
  } catch {
    // fail-closed：扫描器异常（如非预期输入）时保守判定为注入，隔离而非放行。
    return { blocked: true, score: -1, hits: [] };
  }
}

/**
 * 护栏变换：对工具结果 output 做注入扫描。
 * - 未命中：原样返回。
 * - 命中：返回净化结果（output 替换为隔离标记，保留「已被拦截」信号），不把疑似注入喂给模型。
 */
export function guardToolResult(
  result: ToolResult,
): ToolResult & { readonly blocked: boolean; readonly hits: readonly InjectionHit[] } {
  if (result.output === undefined) {
    return { ...result, blocked: false, hits: [] };
  }
  const scan = scanForInjection(result.output);
  if (!scan.blocked) {
    return { ...result, blocked: false, hits: [] };
  }
  return {
    ...result,
    output: `[提示注入拦截] 工具结果疑似含指令注入（命中 ${scan.hits.length} 处），已隔离，未进入模型上下文。`,
    blocked: true,
    hits: scan.hits,
  };
}
