/**
 * 确定性提示注入护栏（零依赖，实验性 @beta）。
 *
 * 仅做基于规则的启发式扫描（不引入 ML / 外部服务），用于 opt-in 拦截工具结果 /
 * 外部内容里疑似「指令注入」的片段，避免其直接进入模型上下文。
 * 默认关闭：仅当 config.promptInjectionGuard === true 时由 StepRunner 调用。
 * fail-closed：护栏一旦启用，扫描器自身抛错时**保守拦截**（不把原始结果放行进上下文）。
 *
 * **来源分级（P4 起）**：规则按强度分两层，判定阈值随「内容来源信任级」变化（见 `ToolOutputTrust`）——
 * - **强规则**（明确的指令覆盖 / 角色伪造 / 数据外泄）：任何来源命中即隔离；
 * - **弱规则**（行首 `system:` / `assistant:`、`you are now X`、`act as X` 等上下文相关短语）
 *   与**指令式启发式**（间接提示注入的常见措辞）：按来源阈值判定——外部抓取/未知来源 1 条即拦，
 *   文件内容需 2 条，本机命令输出需 3 条（日志噪声高，降低误报）。
 *
 * 不传来源（默认 `unknown`，阈值 1）时判定为「任意命中即拦」，
 * 与 P4 之前的行为**逐字等价**（既有调用方零行为变更）。
 */

import type { ToolResult } from '../ports/tool/tool.js';
import type { EnforcementMode } from './enforcementModeResolver.js';
import { ToolOutputTrust, type TrustTier } from './toolOutputTrust.js';

/** 规则强度：`strong` 恒拦；`weak` 计入门限证据数（阈值随来源变化）。 */
export type InjectionSeverity = 'strong' | 'weak';

export interface InjectionHit {
  /** 命中规则的正则源（用于可观测 / 审计）。 */
  readonly pattern: string;
  /** 命中片段（截断，避免把注入内容原样回显）。 */
  readonly snippet: string;
  /** 规则强度（强规则恒拦；弱规则按来源阈值累计）。 */
  readonly severity: InjectionSeverity;
}

export interface InjectionScan {
  /** 是否判定为注入（强规则命中，或弱证据数达到该来源阈值）。 */
  readonly blocked: boolean;
  /** 命中规则数（强 + 弱；扫描器异常时为 -1）。 */
  readonly score: number;
  /** 命中的规则明细。 */
  readonly hits: readonly InjectionHit[];
  /** 本次判定所用的来源信任级。 */
  readonly tier: TrustTier;
}

/**
 * 强规则：明确的指令覆盖 / 角色伪造 / 数据外泄——任何来源命中即隔离。
 * 这些措辞在正当技术文本里几乎不可能自然出现，故不设来源门限。
 */
const STRONG_DIRECTIVES: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts?|context)/i,
  /disregard\s+(?:(?:all|any|the|this|that|these|those|my|your)\s+){0,3}(?:previous|prior|above|earlier|preceding|everything)\b/i,
  /forget\s+(?:everything|all\s+(?:previous|prior))\s+/i,
  /\[\s*SYS(?:TEM)?\s*\]/i,
  /<\s*system\s*>/i,
  /<\s*assistant\s*>/i,
  /do\s+not\s+tell\s+(?:the\s+)?user/i,
  /reveal\s+your\s+(?:instructions|prompt|system\s+prompt|configuration)/i,
  /override\s+(?:your|the)\s+(?:instructions|guidelines|rules|system)/i,
  /new\s+instructions?\s*:/i,
  /execute\s+the\s+following\s+(?:command|instructions?)\s*:/i,
];

/**
 * 弱规则：上下文相关——日志行、对话记录、叙事文本里也可能自然出现。
 * 单条弱命中不足以定性，需按来源累计到该信任级的阈值。
 */
const WEAK_DIRECTIVES: readonly RegExp[] = [
  /(?:^|\n)\s*system\s*:\s*/i,
  /(?:^|\n)\s*assistant\s*:\s*/i,
  /you\s+are\s+now\s+[a-z][a-z\s]{0,24}/i,
  /pretend\s+to\s+be\s+/i,
  /act\s+as\s+(?:a|an)\s+[a-z][a-z\s]{0,24}/i,
];

/**
 * 指令式启发式：间接提示注入（Indirect Prompt Injection）的常见措辞——
 * 面向 AI 的祈使句、凭据外泄请求、角色重设宣言。
 * 单独出现时可能是正当文档，因此按来源阈值判定（外部/未知 1 条即拦，文件 2 条，本机 3 条）。
 */
const INSTRUCTION_HEURISTICS: readonly RegExp[] = [
  /if\s+you\s+are\s+(?:an?\s+)?(?:ai|agent|assistant|llm|chatbot|language\s+model)/i,
  /note\s+to\s+(?:the\s+|all\s+)?(?:ai|agent|assistants?|llms?)/i,
  /(?:send|forward|upload|post|exfiltrate|transfer)\s+(?:all\s+|the\s+)*(?:contents?\s+of\s+)?(?:your\s+)?(?:\.env|~?\/?\.ssh|id_rsa|credentials|api[\s_-]?keys?|secrets?|passwords?|tokens?)/i,
  /from\s+now\s+on\s*,?\s*(?:you|please|respond|treat|ignore|obey|only|do\s+not)/i,
  /treat\s+the\s+following\s+as\s+(?:your\s+)?(?:new\s+)?(?:system\s+)?(?:prompt|instructions?|rules)/i,
  /respond\s+only\s+(?:in|with)\s+/i,
  /(?:you\s+)?must\s+(?:now\s+)?(?:ignore|obey|comply\s+with|reveal|output|send|execute|transfer|delete)\s+/i,
  /as\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken|unconstrained)\s/i,
];

/**
 * 按来源信任级扫描文本，返回命中明细。
 *
 * 判定：强规则命中 ⇒ blocked；否则弱 + 启发式命中数 ≥ {@link ToolOutputTrust.weakEvidenceThreshold}
 * ⇒ blocked。默认 `tier = 'unknown'`（阈值 1）等价于「任意命中即拦」，向后兼容。
 *
 * @param text 待扫描文本（工具结果 output / 外部内容）。
 * @param tier 内容来源信任级（缺省 `unknown`，行为同 P4 之前）。
 * @returns 命中明细与判定结果（含本次所用信任级）。
 */
export function scanForInjection(text: string, tier: TrustTier = 'unknown'): InjectionScan {
  if (text.length === 0) {
    return { blocked: false, score: 0, hits: [], tier };
  }
  try {
    const hits: InjectionHit[] = [];
    for (const re of STRONG_DIRECTIVES) {
      const m = re.exec(text);
      if (m !== null) {
        hits.push({ pattern: re.source, snippet: m[0].slice(0, 64), severity: 'strong' });
      }
    }
    const weakHits: InjectionHit[] = [];
    for (const re of [...WEAK_DIRECTIVES, ...INSTRUCTION_HEURISTICS]) {
      const m = re.exec(text);
      if (m !== null) {
        weakHits.push({ pattern: re.source, snippet: m[0].slice(0, 64), severity: 'weak' });
      }
    }
    const blocked =
      hits.length > 0 || weakHits.length >= ToolOutputTrust.weakEvidenceThreshold(tier);
    return { blocked, score: hits.length + weakHits.length, hits: [...hits, ...weakHits], tier };
  } catch {
    // fail-closed：扫描器异常（如非预期输入）时保守判定为注入，隔离而非放行。
    return { blocked: true, score: -1, hits: [], tier };
  }
}

/**
 * 护栏变换：对工具结果 output 做注入扫描。
 * - 未命中：原样返回。
 * - 命中：返回净化结果（output 替换为隔离标记，保留「已被拦截」信号），不把疑似注入喂给模型。
 *
 * @param result 工具结果（含调用方已知的工具名来源，见 `ToolOutputTrust.fromToolName`）。
 * @param tier 该结果的内容来源信任级（缺省 `unknown`，行为同 P4 之前）。
 * @returns 隔离后的结果（附 `blocked` / `hits` / `tier` 以便可观测）。
 */
export function guardToolResult(
  result: ToolResult,
  tier: TrustTier = 'unknown',
): ToolResult & {
  readonly blocked: boolean;
  readonly hits: readonly InjectionHit[];
  readonly tier: TrustTier;
} {
  if (result.output === undefined) {
    return { ...result, blocked: false, hits: [], tier };
  }
  const scan = scanForInjection(result.output, tier);
  if (!scan.blocked) {
    return { ...result, blocked: false, hits: [], tier };
  }
  return {
    ...result,
    output: `[提示注入拦截] 工具结果疑似含指令注入（来源 ${ToolOutputTrust.labelOf(tier)}，命中 ${scan.hits.length} 处），已隔离，未进入模型上下文。`,
    blocked: true,
    hits: scan.hits,
    tier,
  };
}

/**
 * 扫描器**自身异常**时的兜底结果（D2：兜底策略按模式区分，且本层绝不静默放行）。
 *
 * 为什么按模式区分、而不是一律 fail-closed：
 *  - `enforce` 档的契约是「不让疑似注入进入模型上下文」——扫描器异常时**必须保守隔离**，
 *    否则「扫描器坏了」就等于「护栏不存在」，这正是 §17.2 D2 所指的漏；
 *  - `shadow` 档的契约是「跑、记、但不改行为」——此时若隔离，就等于 shadow **悄悄改了行为**，
 *    反而毁掉它唯一的用途（在生产流量上量真实误报/漏报）；
 *  - `off` 档本就不跑，原样返回。
 *
 * @param result 原始工具结果。
 * @param mode 生效模式。
 * @returns `enforce` ⇒ 带隔离标记的结果；`shadow` / `off` ⇒ 原样返回。
 */
export function guardFailureResult(result: ToolResult, mode: EnforcementMode): ToolResult {
  if (mode !== 'enforce') {
    return result;
  }
  return {
    ...result,
    output: '[提示注入拦截] 护栏扫描器异常，按 fail-closed 隔离该结果，未进入模型上下文。',
  };
}
