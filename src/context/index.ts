/**
 * 上下文效率层（自研 · 零依赖）。
 *
 * 生态位：竞品调研显示，Agent 侧唯一能拿到数量级收益的是「裁剪进入上下文的字节数」，
 * 而所有依赖模型权重的压缩方案（LLMLingua 全系）在零依赖铁律下出局。
 * 本层提供纯算法替代：确定性压缩 + 前缀稳定性治理，二者均可机械证明。
 */

export * from './canonical.js';
export * from './prefixStability.js';
export * from './deterministicCompressor.js';
