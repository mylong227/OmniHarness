/**
 * 元认知信念端口（MetacognitionPort，P2 · 信念支柱）。
 *
 * 把"信念"建模为统计流形上的分布，提供两类可审计更新：
 * - `naturalStep`：自然梯度（信息几何）——沿逆 Fisher 度规（此处=逆对角协方差）预处理梯度后步进；
 * - `correct`：观测修正（贝叶斯 / 粒子滤波）——给定观测与噪声，更新信念。
 *
 * 每次更新返回 **可审计 KL 分解**：本次更新在信念流形上引起的 KL 散度被拆成可命名分量
 * （均值漂移 / 方差变化 / 逐维明细），并附 **重参数化不变性审计**（维度排列下总 KL 与分解一致，
 * 坐标图无关——信息几何铁律）。运行时无第三方依赖。
 *
 * 本文件已退化为桶：4 个接口各自独立成文件于 `./metacognition/`，调用点零改动。
 */

export type { BeliefSnapshot } from './metacognition/beliefSnapshot.js';
export type { BeliefKlComponent } from './metacognition/beliefKlComponent.js';
export type { BeliefUpdateReport } from './metacognition/beliefUpdateReport.js';
export type { MetacognitionPort } from './metacognition/metacognitionPort.js';
