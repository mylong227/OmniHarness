/**
 * 非牛顿固化存储端口（燧-2 原语，零依赖，实验性 @beta）。
 *
 * 把「剪切增稠非牛顿流体（oobleck）」的力学行为抽象为存储语义：
 * - 低应力（冲击 < 屈服应力 τ）下处于「液态」：可反复覆盖写入，状态松弛。
 * - 单笔写入的冲击一旦越过 τ，材料「剪切增稠」并**永久冻结**（rig=1），提交在那一刻发生。
 * - 冻结后任何写入/删除均被拒绝（fail-closed，不可变）。
 *
 * 关键差异（市面无对应原语）：冻结是「某笔写入的冲击越过阈值」**涌现**出来的，
 * 而不是由某个显式 `freeze()` 调用触发的——提交语义是冲击涌现的，而非命令式写。
 */

export type { OobleckRecord } from './oobleck/oobleckRecord.js';
export type { OobleckWriteResult } from './oobleck/oobleckWriteResult.js';
export type { OobleckPort } from './oobleck/oobleckPort.js';
