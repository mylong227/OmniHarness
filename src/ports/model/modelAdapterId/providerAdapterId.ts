import type { ModelAdapterId } from './modelAdapterId.js';

/**
 * 厂商预设可用的适配器子集：`mock` 不连任何端点、`llamacpp` 是本地原生协议，
 * 两者都不适合做「厂商」预设（预设必须有端点与模型清单）。
 */
export type ProviderAdapterId = Exclude<ModelAdapterId, 'mock' | 'llamacpp'>;
