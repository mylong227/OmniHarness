/**
 * 媒体子进程执行端口（窄接口）。
 *
 * ## 为什么需要这一层
 *
 * 视频抽帧依赖**本机外部二进制**（ffmpeg / ffprobe）。如果适配器直接 `spawn`，
 * 那么「参数是否正确」「超时是否真的生效」「输出超限是否被截断」这些**决定成败的行为**
 * 就只能在有 ffmpeg 的机器上验证——绝大多数 CI 环境都没有。把「跑一个受控子进程」
 * 抽成窄端口后：生产走 `SpawnMediaProcessRunner`，单测注入替身即可
 * 对**参数、超时、截断、失败路径**做逐条断言（本仓既有 `TestCommandRunner` 同款做法）。
 *
 * ## 契约
 *
 * 不抛异常：进程启动失败以 `spawnError` 回传，超时以 `timedOut` 回传，输出超限以
 * `truncated` 回传。调用方据这些**显式状态**决定是重试、降级还是如实报错——
 * 「静默为空输出」是最难排查的一类故障。
 */

/** 单次子进程执行请求。 */
export interface MediaProcessRequest {
  /** 可执行文件路径（绝对路径或 PATH 中的名字）。 */
  readonly command: string;
  /** 参数数组（**不经 shell**，故无需转义，也不会被 `&`/`|` 之类字符影响）。 */
  readonly args: readonly string[];
  /** 超时（毫秒）：到点即杀掉子进程并置 `timedOut`。 */
  readonly timeoutMs: number;
  /** stdout 字节上限：超出即停止累积并置 `truncated`。 */
  readonly maxOutputBytes: number;
  /** 会话取消信号（可选）：触发即杀掉子进程。 */
  readonly signal?: AbortSignal | undefined;
}

/** 单次子进程执行结果（全部状态显式回传，不抛异常）。 */
export interface MediaProcessOutcome {
  /** 退出码（被信号终止或未启动时为 `null`）。 */
  readonly exitCode: number | null;
  /** stdout 字节（可能被截断）。 */
  readonly stdout: Buffer;
  /** stderr 文本（已按上限截断）。 */
  readonly stderr: string;
  /** 是否因超时被杀。 */
  readonly timedOut: boolean;
  /** stdout 是否被上限截断。 */
  readonly truncated: boolean;
  /** 启动失败原因（如 `ENOENT`）；正常启动后为 `undefined`。 */
  readonly spawnError: string | undefined;
}

/** 媒体子进程执行端口。 */
export interface MediaProcessRunner {
  /**
   * 在受控预算内执行一条命令。
   *
   * @param request 执行请求。
   * @returns 单次执行结果（不抛异常）。
   */
  run(request: MediaProcessRequest): Promise<MediaProcessOutcome>;
}
