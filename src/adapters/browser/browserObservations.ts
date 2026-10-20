/** 观测保留条数上限。 */
const MAX_OBSERVATIONS = 80;

/**
 * 有界 console / 失败网络观测（2026-10-21 从 `BrowserSession` 拆出）。
 *
 * 由 `BrowserSession` 订阅 CDP 事件写入，`CdpBrowserActions` 读取并渲染给模型。
 */
export class BrowserObservations {
  /** 本页 console 输出（有界）。 */
  private readonly consoleLines: string[] = [];
  /** 本页失败网络请求（有界）。 */
  private readonly networkFailures: string[] = [];

  /**
   * 记录一条 console 事件。
   * @param params CDP `Runtime.consoleAPICalled` 参数。
   * @returns 无返回值。
   */
  public console(params: unknown): void {
    const payload = params as {
      type?: unknown;
      args?: readonly { value?: unknown; description?: unknown }[];
    };
    const type = typeof payload.type === 'string' ? payload.type : 'log';
    const text = (payload.args ?? [])
      .map((arg) =>
        typeof arg.value === 'string'
          ? arg.value
          : typeof arg.description === 'string'
            ? arg.description
            : '',
      )
      .filter((part) => part !== '')
      .join(' ');
    BrowserObservations.pushBounded(this.consoleLines, `[${type}] ${text}`);
  }

  /**
   * 记录一条失败网络请求。
   * @param params CDP `Network.loadingFailed` 参数。
   * @returns 无返回值。
   */
  public networkFailure(params: unknown): void {
    const payload = params as { errorText?: unknown; blockedReason?: unknown };
    const reason =
      typeof payload.errorText === 'string'
        ? payload.errorText
        : typeof payload.blockedReason === 'string'
          ? payload.blockedReason
          : 'unknown';
    BrowserObservations.pushBounded(this.networkFailures, `请求失败：${reason}`);
  }

  /**
   * 记录一条 HTTP 错误响应（>=400）。
   * @param params CDP `Network.responseReceived` 参数。
   * @returns 无返回值。
   */
  public networkStatus(params: unknown): void {
    const payload = params as { response?: { status?: unknown; url?: unknown } };
    const status = typeof payload.response?.status === 'number' ? payload.response.status : 0;
    if (status < 400) return;
    const url = typeof payload.response?.url === 'string' ? payload.response.url : '';
    BrowserObservations.pushBounded(this.networkFailures, `${String(status)} ${url}`);
  }

  /**
   * 渲染 console 文本。
   * @returns 最近 console 行；无输出时为占位文本。
   */
  public consoleOutput(): string {
    return this.consoleLines.join('\n') || '（无 console 输出）';
  }

  /**
   * 渲染失败网络文本。
   * @returns 最近失败请求；无失败时为占位文本。
   */
  public networkOutput(): string {
    return this.networkFailures.join('\n') || '（无失败请求）';
  }

  /**
   * 有界 push。
   * @param list 目标数组。
   * @param line 新行。
   * @returns 无返回值。
   */
  private static pushBounded(list: string[], line: string): void {
    list.push(line);
    if (list.length > MAX_OBSERVATIONS) list.shift();
  }
}
