/** 一条适配器在**给定环境变量表**下解析出的生效值。 */
export interface ResolvedAdapterDefaults {
  /** 适配器标识。 */
  readonly id: string;
  /** 生效端点：`baseUrlEnv` 有值则用它，否则用数据文件的 `baseUrl`。 */
  readonly baseUrl: string;
  /** 生效模型名：`modelEnv` 有值则用它，否则用数据文件的 `model`。 */
  readonly model: string;
  /** 生效 API Key：`apiKeyEnv` 有值则用它，否则 undefined。 */
  readonly apiKey: string | undefined;
  /** 是否必须提供 API Key。 */
  readonly requiresApiKey: boolean;
  /** API Key 的环境变量名（用于错误提示）。 */
  readonly apiKeyEnv?: string;
}
