import type { ModelAdapterId } from '../model/modelAdapterId.js';

/**
 * @beta
 * 定时任务可用的模型适配器：直接复用端口层唯一清单推导出的联合类型
 * （本处曾手写一份同样的 5 元联合，与 `CliArgs` / `FileConfig` / 校验白名单重复；见 §3.4 收口）。
 */
export type RoutineModelAdapter = ModelAdapterId;
