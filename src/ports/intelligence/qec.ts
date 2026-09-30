/**
 * QEC 式可校验记忆端口（I-P1-3）。S+ 发明层。
 *
 * 把长期记忆建成"稳定子+症状（syndrome）"编码块：用二维奇偶症状（行/列 XOR）编码每条事实，
 * 只读症状即可**定位单点 corrupt 并纠正**（阈值定理风味），直击灾难性遗忘；多点 corrupt
 * 无法定位则标记 uncorrectable（fail-closed，绝不静默接受损坏内容）。向量库/副本式记忆在
 * 代数上无此"可校验纠错"维度（市面唯一）。
 */

export type { QECStatus } from './qec/qecStatus.js';
export type { QECReport } from './qec/qecReport.js';
export type { QECEncoderPort } from './qec/qecEncoderPort.js';
