import type { ModelAdapterId } from './modelAdapterId.ts';

/**
 * 厂商预设可用的适配器子集：`mock` 不连任何端点、`llamacpp` 是本地原生协议、
 * `gemini` 是独立的原生协议（暂不由厂商目录/探测路径承载），三者都不适合做「厂商」预设
 * （预设必须有端点与可被 `/models` 探测的模型清单）。
 */
export type ProviderAdapterId = Exclude<ModelAdapterId, 'mock' | 'llamacpp' | 'gemini'>;
