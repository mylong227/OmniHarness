// 事件流渲染模型（2026-11-02 从 StreamView 下沉）。
//
// 缓存本体是模块级单例（`StreamModelCache`），本文件只负责「按 (events 引用, 长度, busy)
// 取用」这一层接线。它没有内部 state，之所以按 hook 形态命名与调用，是为了让
// 「组件体里不许出现派生计算」这条口径在调用点上可见。
//
// 为什么必须缓存：滚动帧也会重渲染（`scrollTop` 是 state），而这几项派生是 O(事件数)
// （审计 §2.5 实测每帧 ≈180 µs@1000、≈510 µs@3000 事件），滚动时它们**一个输入都没变**。

import { StreamModelCache } from '../../models/StreamModelCache.ts';
import type { StreamModel } from '../../models/StreamModelCache.ts';
import type { ThreadEvent } from '../../../types/models.ts';

/** 事件流模型缓存：滚动帧复用同一批派生结果（键＝events 引用 + 长度 + busy）。 */
const STREAM_MODEL_CACHE = new StreamModelCache();

/**
 * 取（必要时重算）事件流模型：块 / 块 key / 末条用户与助手 id / 工具调用 id 集合 / 分段用时。
 * @param events 事件数组（引用与长度共同构成失效判据）
 * @param busy 回合是否进行中（影响过程簇折叠口径）
 * @returns 渲染模型（同一输入重复取用返回**同一对象**）
 */
export function useStreamModel(events: readonly ThreadEvent[], busy: boolean): StreamModel {
  return STREAM_MODEL_CACHE.get(events, busy);
}
