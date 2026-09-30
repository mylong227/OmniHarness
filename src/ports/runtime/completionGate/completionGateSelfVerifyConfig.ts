/** 闸门消费的自验证声明字段（结构子集，避免端口绑死配置实现）。 */
export interface CompletionGateSelfVerifyConfig {
  /** 是否启用写时自验证；显式 `false` 视为「验证」的整体退出。 */
  readonly enabled?: boolean | undefined;
  /** 显式测试命令（缺省由工作区证据推断）。 */
  readonly command?: string | undefined;
  /** 单次验证超时（毫秒）。 */
  readonly timeoutMs?: number | undefined;
  /** 回灌摘要的输出字节上限。 */
  readonly maxOutputBytes?: number | undefined;
  /** 回灌摘要的最大行数。 */
  readonly maxDigestLines?: number | undefined;
}
