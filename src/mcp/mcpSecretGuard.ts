/**
 * MCP 错误信息的凭据脱敏（fail-closed 防线）。
 *
 * 安全口径：错误码/错误信息**不得**泄露 secret。常见泄露形态是：
 *  - 直接拼接 token/client_secret；
 *  - `Authorization: Bearer …`；
 *  - `access_token=…` / `refresh_token=…` / `client_secret=…` / `code=…` 表单片段。
 *
 * 本类只做**文本替换**，不做协议判断；调用方在把错误写进 JSON-RPC error / 日志前调用。
 */
export class McpSecretGuard {
  /** 脱敏占位符。 */
  public static readonly REDACTED = '[redacted]';

  /** 键值形态的敏感字段（表单 / query / 日志）。 */
  private static readonly KEY_VALUE =
    /(\b(?:access_token|refresh_token|id_token|client_secret|code_verifier|code)=)([^&\s,;'"]+)/giu;

  /** Authorization 头形态。 */
  private static readonly BEARER = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/giu;

  /**
   * 脱敏文本。
   * @param text 原始文本。
   * @param secrets 调用方已知的敏感值（逐字替换；空/过短的值跳过，避免误伤普通单词）。
   * @returns 脱敏后的文本。
   */
  public static redact(text: string, secrets: readonly (string | undefined)[] = []): string {
    let result = text;
    for (const secret of secrets) {
      if (secret === undefined || secret.trim().length < 6) continue;
      result = result.split(secret).join(McpSecretGuard.REDACTED);
    }
    result = result.replace(McpSecretGuard.KEY_VALUE, `$1${McpSecretGuard.REDACTED}`);
    result = result.replace(McpSecretGuard.BEARER, `$1${McpSecretGuard.REDACTED}`);
    return result;
  }

  /**
   * 脱敏异常消息（保留 `Error` 的 name/stack 形状之外的语义，构造新 Error）。
   * @param error 原始异常。
   * @param secrets 已知敏感值。
   * @returns 脱敏后的 Error（消息可安全上线缆）。
   */
  public static redactError(error: unknown, secrets: readonly (string | undefined)[] = []): Error {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = McpSecretGuard.redact(message, secrets);
    const out = new Error(redacted);
    out.name = error instanceof Error ? error.name : 'Error';
    return out;
  }
}
