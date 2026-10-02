/**
 * @beta
 * 启动外部语言服务器的配置。
 * 仅声明「怎么把服务器跑起来」，**不引入任何 npm 运行时依赖**——服务器由用户自备（如 typescript-language-server），
 * harness 通过子进程 stdio 用 LSP 协议与其通信。这是保持「无第三方依赖铁律」前提下的 LSP 接入方式（对标 codex 的 stdio 桥接）。
 */
export interface LspServerConfig {
  /** 启动命令（须在 PATH 或给绝对路径，如 `typescript-language-server`）。 */
  readonly serverCommand: string;
  /** 启动参数（如 `['--stdio']`）。 */
  readonly serverArgs?: readonly string[] | undefined;
  /**
   * 工程根 URI（file://...）。不传时由运行时用 workspaceRoot 推导。
   * 多数语言服务器以 rootUri 决定项目范围与索引根。
   */
  readonly rootUri?: string | undefined;
}
