/**
 * A2A 协议错误：让服务端把「规范错误码」与「内部异常」分开透传。
 *
 * 无此类型时所有异常都被压成 INVALID（-32602），于是标准客户端无法区分
 * 「任务不存在」（-32001）与「参数写错」（-32602）——推送/取消/订阅的失败归因全靠猜。
 */
export class A2aProtocolError extends Error {
  /**
   * @param message 可读错误原因。
   * @param code A2A / JSON-RPC 错误码（缺省 INVALID）。
   */
  public constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = 'A2aProtocolError';
  }
}
