/**
 * 记忆退火端口（热方程记忆重加权 / 退火调度）。S+ 发明层知识基础算子。
 *
 * 把长期记忆建模为一张"事实图"：节点是记忆事实，边是它们之间的共振耦合
 * （复用燧-3 频率域共振度）。在图上跑离散热方程（扩散），让共振簇内重要性趋于
 * 共识、孤立事实自然消退；同时以温度调度 T(t) 控制重加权强度——高温时激进重排、
 * 低温时冻结，即"退火"。几何/向量范式在代数上不支持此算子（市面唯一）。
 */

export type { AnnealStepReport } from './memoryAnnealing/annealStepReport.js';
export type { MemoryAnnealer } from './memoryAnnealing/memoryAnnealer.js';
