import { MODEL_ADAPTER_IDS } from './modelAdapterIds.js';

/** 模型适配器标识联合类型（由清单推导，不再手写）。 */
export type ModelAdapterId = (typeof MODEL_ADAPTER_IDS)[number];
