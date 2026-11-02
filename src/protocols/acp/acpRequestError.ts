/**
 * ACP JSON-RPC 错误：区分「协议错误码」与「可读原因」。
 *
 * 服务端只把带本类实例的错误码透传给 Client；其余异常一律收敛为内部错误，
 * 避免把宿主堆栈/路径泄漏到编辑器侧。
 */
export class AcpRequestError extends Error {
  /**
   * @param message 可读错误原因。
   * @param code JSON-RPC 错误码（缺省内部错误）。
   */
  public constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = 'AcpRequestError';
  }
}
