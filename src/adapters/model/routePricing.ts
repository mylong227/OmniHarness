import type { RoutePrice } from '../../ports/model.js';

/**
 * @beta
 * 默认路由定价表（#S29，单位 USD / 百万 token）。
 * 仅供成本计量参考，非计费凭据；前缀匹配生效（如 `gpt-4o-2024-...` → `gpt-4o`）。
 */
export const DEFAULT_ROUTE_PRICING: Record<string, RoutePrice> = {
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  o1: { inputPer1M: 15, outputPer1M: 60 },
  o3: { inputPer1M: 10, outputPer1M: 40 },
  'deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  'claude-3-5-sonnet': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-haiku': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-3-opus': { inputPer1M: 15, outputPer1M: 75 },
  llama: { inputPer1M: 0, outputPer1M: 0 },
  local: { inputPer1M: 0, outputPer1M: 0 },
  llamacpp: { inputPer1M: 0, outputPer1M: 0 },
};

/**
 * @beta
 * 兜底定价（未知模型）：取中等价位，避免计费恒为 0 而漏熔断。
 */
export const DEFAULT_FALLBACK_PRICE: RoutePrice = { inputPer1M: 1.0, outputPer1M: 3.0 };

/**
 * @beta
 * 把用户自定义定价表叠到默认表之上（用户表优先）。
 */
export function mergeRoutePricing(custom?: Record<string, RoutePrice>): Map<string, RoutePrice> {
  const merged = new Map<string, RoutePrice>();
  for (const [key, value] of Object.entries(DEFAULT_ROUTE_PRICING)) {
    merged.set(key, value);
  }
  if (custom !== undefined) {
    for (const [key, value] of Object.entries(custom)) {
      merged.set(key, value);
    }
  }
  return merged;
}
