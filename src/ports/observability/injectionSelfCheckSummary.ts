/**
 * 注入护栏离线自检的**摘要契约**（2026-10-11 从 `src/security/injectionSelfCheck.ts` 外迁）。
 *
 * 为什么外迁：`doctor.report` 的契约类型要进端口层（见 `doctorReport.ts` 的理由），而它引用本类型
 * —— 端口不能反向依赖实现文件（架构门禁 `[3.5]`，白名单已清空）。本类型是纯量集合，天然属于端口层；
 * 原位置改为导入 + 再导出，调用点零改动。
 */
export interface InjectionSelfCheckSummary {
  /** 快照用例总数。 */
  readonly cases: number;
  /** 检测率 recall = TP / (TP + FN)，越高越好。 */
  readonly recall: number;
  /** 误报率 FP / (FP + TN)，越低越好。 */
  readonly falsePositiveRate: number;
  /** 精度 TP / (TP + FP)，越高越好。 */
  readonly precision: number;
  /** 口径注记（逐字转述，防「离线代理数字被当真实攻击统计」）。 */
  readonly basis: string;
}
