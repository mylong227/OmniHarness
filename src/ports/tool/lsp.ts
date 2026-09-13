/**
 * @beta
 * 编辑器坐标系下的单点位置（1-based 行/列，与用户/模型所见一致）。
 */
export interface LspPosition {
  /** 行（从 1 开始）。 */
  readonly line: number;
  /** 列（从 1 开始）。 */
  readonly character: number;
}

/**
 * @beta
 * 编辑器坐标系下的区间（1-based）。
 */
export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/**
 * @beta
 * 一个代码位置（已转回编辑器坐标，uri 为普通文件系统路径而非 file://）。
 */
export interface LspLocation {
  /** 文件系统绝对路径（适配器已把 file:// URI 转回）。 */
  readonly uri: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
}

/**
 * @beta
 * 启动外部语言服务器的配置。
 * 仅声明「怎么把服务器跑起来」，**不引入任何 npm 运行时依赖**——服务器由用户自备（如 typescript-language-server），
 * harness 通过子进程 stdio 用 LSP 协议与其通信。这是保持「零依赖铁律」前提下的 LSP 接入方式（对标 codex 的 stdio 桥接）。
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

/**
 * @beta
 * LSP 代码导航端口：definition / references / hover。
 *
 * 实现负责 LSP 握手（initialize → initialized）、文档同步（didOpen）、生命周期（shutdown → exit），
 * 对上层完全透明——工具/CLI 只调语义方法。坐标统一 **1-based 编辑器约定**，0-based 的 LSP 细节由适配器内部转换。
 *
 * fail-closed：服务器不可用 / 请求超时 / 协议错误时，方法应抛出（由工具层转成可读错误文本），绝不静默返回错误结果。
 */
export interface LspPort {
  /** 端口名（便于调试/状态展示）。 */
  readonly name: string;
  /** 跳转到定义：返回 0..n 个位置（部分语言/符号可能返回多个）。 */
  definition(file: string, line: number, character: number): Promise<readonly LspLocation[]>;
  /** 查找引用：返回所有引用位置（含声明处，若服务器支持）。 */
  references(file: string, line: number, character: number): Promise<readonly LspLocation[]>;
  /** 悬停文档：返回 Markdown/纯文本文档串，无则 undefined。 */
  hover(file: string, line: number, character: number): Promise<string | undefined>;
  /** 关闭会话：发 shutdown → exit 并终止子进程。 */
  shutdown(): Promise<void>;
}
