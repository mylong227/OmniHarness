/**
 * 模型路由条目配置（底层适配器 + 模型名 + 可选定价）。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface ModelRouterEntryConfig {
  readonly model: string;
  /** 底层适配器类型（缺省 mock）；构造时复用既有的模型适配器逻辑。 */
  readonly adapter?: string;
  /** 每千 token 定价（USD），least-cost 用。 */
  readonly pricing?: { readonly inputPer1k: number; readonly outputPer1k: number };
}
