/**
 * Plugin Worker 协议/生命周期常量（ADR-0012）。
 *
 * 为什么单独成类：帧上限、超时与停机宽限原先散落在 supervisor / worker / broker 三处，
 * 改一个忘另一个会让父子端对"合法帧"产生分歧（表现为随机断连）。集中一处后，
 * Worker 通过环境变量接收帧上限，父进程与子进程始终同源。
 */
export class PluginWorkerLimits {
  /** 单帧上限（1 MiB）：协议行超过即视为非法。 */
  public static readonly MAX_FRAME_BYTES = 1_048_576;
  /** 缺省工具调用超时（30s）。 */
  public static readonly DEFAULT_CALL_TIMEOUT_MS = 30_000;
  /** 缺省激活/握手超时（10s）。 */
  public static readonly DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
  /** 停止时等待子进程退出的宽限（1s）。 */
  public static readonly SHUTDOWN_GRACE_MS = 1_000;
  /** 停止时等待 deactivate 响应的宽限（2s）。 */
  public static readonly DEACTIVATE_TIMEOUT_MS = 2_000;
  /** 能力 broker 单次读取字节上限（1 MiB）。 */
  public static readonly CAPABILITY_READ_MAX_BYTES = 1_048_576;
  /** 能力 broker 单次写入字节上限（1 MiB）。 */
  public static readonly CAPABILITY_WRITE_MAX_BYTES = 1_048_576;
  /** 插件 KV 单值上限（256 KiB）。 */
  public static readonly CAPABILITY_STORE_MAX_BYTES = 262_144;
}
