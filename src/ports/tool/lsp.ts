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
 * 诊断严重度（对齐 LSP `DiagnosticSeverity`，缺失时按 warning 处理）。
 */
export type LspDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * @beta
 * 单条诊断（坐标已转回 1-based 编辑器约定）。
 */
export interface LspDiagnostic {
  /** 所属文件系统绝对路径（适配器已把 file:// URI 转回）。 */
  readonly file: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
  /** 严重度。 */
  readonly severity: LspDiagnosticSeverity;
  /** 诊断消息（服务器原文，未做本地化）。 */
  readonly message: string;
  /** 产生该诊断的源（如 `typescript`）。 */
  readonly source?: string | undefined;
  /** 服务器给出的诊断码（如 `TS2304`）。 */
  readonly code?: string | undefined;
}

/**
 * @beta
 * 诊断报告。
 *
 * **`status` 是刻意保留的语义**：语言服务器是异步推送诊断的，等待窗口内没有收到推送
 * **不等于**「没有错误」。因此本报告显式区分：
 * - `fresh`：本次请求期间收到了该文件的 `publishDiagnostics` ⇒ 诊断即当前真值（含「确实为空」）；
 * - `stale`：仅在等待窗口内未收到推送，返回的是缓存（可能为空、也可能过期）⇒ 调用方
 *   必须把这一区别如实告诉模型，**绝不允许把 stale 当成「编译通过」**。
 */
export interface LspDiagnosticReport {
  /** 目标文件系统绝对路径。 */
  readonly file: string;
  /** 诊断列表（fresh 时即当前真值）。 */
  readonly diagnostics: readonly LspDiagnostic[];
  /** 数据新鲜度。 */
  readonly status: 'fresh' | 'stale';
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
 * 文档符号种类的人类可读名（对齐 LSP `SymbolKind` 数值）。
 *
 * 为什么不直接暴露数值：模型看到 `kind: 12` 无从判断这是函数还是变量，
 * 而符号查询的全部价值就在于「一眼看出这个文件里有什么、长什么样」。
 * 未知数值回落 `symbol#<n>` 而**不丢信息**——宁可显示得笨一点，也不假装认识。
 */
export type LspSymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'package'
  | 'class'
  | 'method'
  | 'property'
  | 'field'
  | 'constructor'
  | 'enum'
  | 'interface'
  | 'function'
  | 'variable'
  | 'constant'
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'key'
  | 'null'
  | 'enum-member'
  | 'struct'
  | 'event'
  | 'operator'
  | 'type-parameter'
  | `symbol#${number}`;

/**
 * @beta
 * 文档内的一个符号（已把层级压平并按深度缩进名字）。
 */
export interface LspSymbol {
  /** 符号名；嵌套符号带前导缩进（每层两个空格），使层级在纯文本里可见。 */
  readonly name: string;
  /** 符号种类（人类可读）。 */
  readonly kind: LspSymbolKind;
  /** 所属文件系统绝对路径（URI 已转回）。 */
  readonly file: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
}

/**
 * @beta
 * 工作区内的一处符号（`workspace/symbol` 的结果条目）。
 *
 * 与 {@link LspSymbol} 的区别只在**语义**：文档符号按文件层级组织（`name` 带缩进），
 * 工作区符号是**跨文件的全局清单**，名字一律顶格（缩进无意义），多出来的
 * `container` 承载「它属于哪个类/模块」——正是模型判断「该跳哪个同名符号」的关键信息。
 */
export interface LspWorkspaceSymbol {
  /** 符号名（不带缩进：全局清单里层级由 `container` 表达）。 */
  readonly name: string;
  /** 符号种类（人类可读）。 */
  readonly kind: LspSymbolKind;
  /** 所属文件系统绝对路径（URI 已转回；服务器连 URI 都没给时回落 `workspace/symbol` 查询串）。 */
  readonly file: string;
  /**
   * 1-based 区间。
   *
   * 服务器只给了文件、没给区间时（LSP 3.17 允许）为**文件起点 1:1**——如实表示
   * 「知道在哪个文件，不知道具体位置」，而不是丢掉这条结果或编一个行号。
   */
  readonly range: LspRange;
  /** 容器名（所属类/模块/包），服务器未给或为空时省略。 */
  readonly container?: string | undefined;
}

/**
 * @beta
 * 一处文本编辑（`WorkspaceEdit` 的最小投影）。
 */
export interface LspTextEdit {
  /** 目标文件系统绝对路径。 */
  readonly file: string;
  /** 1-based 区间。 */
  readonly range: LspRange;
  /** 替换文本。 */
  readonly newText: string;
}

/**
 * @beta
 * 一条代码操作（快速修复/重构建议）。
 *
 * `edits` 是**已压平**的文本编辑列表：语言服务器可能用 `changes`（按 URI 分组）
 * 或 `documentChanges`（带版本与文件操作）两种编码，上层不该关心这个区别。
 * 只有 `command`（需服务器侧执行）而无 `edit` 的操作，`edits` 为空数组——
 * 本层**不下写**任何文件，只把「改哪儿、改成什么」如实呈现，由模型/用户决定。
 */
export interface LspCodeAction {
  /** 操作标题（服务器原文）。 */
  readonly title: string;
  /** 操作种类（如 `quickfix`、`refactor.extract`）；服务器未给则 undefined。 */
  readonly kind?: string | undefined;
  /** 服务器是否标为「首选」。 */
  readonly isPreferred: boolean;
  /** 该操作包含的文本编辑（可能为空）。 */
  readonly edits: readonly LspTextEdit[];
}

/**
 * @beta
 * LSP 代码导航端口：definition / references / hover / diagnostics / symbols / codeActions /
 * workspaceSymbols（工作区级符号搜索）。
 *
 * 实现负责 LSP 握手（initialize → initialized）、文档同步（didOpen / didChange）、生命周期（shutdown → exit），
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
  /**
   * 取文档诊断（编译/类型错误）：强制触发一次文档重新分析并等待推送，返回带新鲜度的报告。
   * 可选——不支持诊断的适配器可省略（缺失时 `lsp_diagnostics` 工具不注册）。
   */
  diagnostics?(file: string): Promise<LspDiagnosticReport>;
  /**
   * 列出文档符号（函数/类/方法/变量的层级清单）。
   *
   * 可选——不支持符号查询的适配器可省略（缺失时 `lsp_document_symbols` 工具不注册）。
   * 之所以对「不支持」留出可选位：注册一个必然失败的工具比不注册更糟，
   * 它会把上下文浪费在一次注定报错的往返上，还给模型一个假信号。
   */
  symbols?(file: string): Promise<readonly LspSymbol[]>;
  /**
   * 取指定区间的代码操作（快速修复/重构）。
   *
   * 可选，理由同 {@link LspPort.symbols}。
   */
  codeActions?(file: string, range: LspRange): Promise<readonly LspCodeAction[]>;
  /**
   * 在工作区范围内按名字模糊查询符号（`workspace/symbol`）。
   *
   * 与 {@link LspPort.symbols} 互补，而不是重复：文档符号要求**先知道文件**，
   * 而模型最常见的起点恰是「只知道一个名字」——它想按名字找定义在哪。
   * 旧做法只能把整个仓库 grep 一遍再逐个打开候选文件，既吃上下文又漏掉
   * 「名字对不上但语义相同」的符号；`workspace/symbol` 直接给出服务器索引里的权威清单。
   *
   * 兼容性：部分服务器返回 `SymbolInformation[]`（扁平、位置在 `location`、可能带 `containerName`），
   * 另一部分返回 `WorkspaceSymbol[]`（位置可能是 `location`，也可能是 LSP 3.17 的 `Location | { uri }`
   * 二选一形态）；实现必须把两种形状**归一**为 {@link LspWorkspaceSymbol}。
   *
   * 可选——不支持全局符号查询的适配器可省略（缺失时 `lsp_workspace_symbols` 工具不注册）。
   * 理由同 {@link LspPort.symbols}：注册一个注定失败的工具比不注册更糟。
   *
   * @param query 符号名查询串（服务器侧通常按子串/模糊匹配；空串在多数服务器上等价于「全部」，
   *   但调用方应自行决定是否允许空查询——本层不做限制，只如实下发）。
   * @returns 工作区符号清单；服务器无可匹配结果或返回非法形状时为空数组。
   */
  workspaceSymbols?(query: string): Promise<readonly LspWorkspaceSymbol[]>;
  /** 关闭会话：发 shutdown → exit 并终止子进程。 */
  shutdown(): Promise<void>;
}
