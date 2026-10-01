/**
 * 模型适配器标识清单（**唯一声明处**；审计 §3.4 收口的最后一段）。详见各子文件。
 *
 * 本文件是纯常量 + 纯类型（无 class、无第三方、无逻辑）。放端口层是因为消费方横跨
 * cli / config / daemon / adapters，而 `daemon/**` 的允许依赖只有 `ports/**`
 * （见 `ARCHITECTURE_SPEC.md` §2.1）⇒ 只有端口层能被所有消费方合法引用。
 */

export { MODEL_ADAPTER_IDS } from './modelAdapterId/modelAdapterIds.js';
export type { ModelAdapterId } from './modelAdapterId/modelAdapterId.js';
export type { ProviderAdapterId } from './modelAdapterId/providerAdapterId.js';
