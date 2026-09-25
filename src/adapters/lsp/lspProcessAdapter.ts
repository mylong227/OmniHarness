import { readFile } from 'node:fs/promises';
import type {
  LspCodeAction,
  LspDiagnosticReport,
  LspLocation,
  LspPort,
  LspRange,
  LspServerConfig,
  LspSymbol,
  LspWorkspaceSymbol,
} from '../../ports/tool/lsp.js';
import { LspUri } from '../../adapters/lsp/lspUri.js';
import { LspJsonRpcConnection } from './lspJsonRpcConnection.js';
import { LspDiagnosticsCollector } from './lspDiagnosticsCollector.js';
import { LspSymbolNormalizer } from './lspSymbolNormalizer.js';
import { LspCodeActionNormalizer } from './lspCodeActionNormalizer.js';
import { LspResultNormalizer } from './lspResultNormalizer.js';

/** 适配器可选项。 */
export interface LspProcessAdapterOptions {
  /** 等待 `publishDiagnostics` 的毫秒数（默认 {@link LspProcessAdapter.DEFAULT_DIAGNOSTICS_TIMEOUT_MS}）。 */
  readonly diagnosticsTimeoutMs?: number;
}

/**
 * @beta
 * 进程级 LSP 适配器（对标 codex 的 stdio 桥接）：
 * 外启语言服务器子进程，用 LSP 协议（stdio JSON-RPC）通信。
 *
 * - **零依赖**：仅用 Node 内置模块，不新增任何 npm 包。
 * - **懒启动**：首个语义调用时才 spawn 子进程并完成 initialize 握手，避免无谓常驻。
 * - **坐标转换**：工具/CLI 给 1-based 编辑器坐标，本适配器内部转 LSP 0-based，返回时再转回 1-based。
 * - **fail-closed**：握手/请求超时、协议错误、进程异常退出均上抛，由工具层转成可读错误文本。
 *
 * 职责边界：本类只负责 **LSP 协议语义**（initialize/didOpen/结果归一化）；
 * 底层 stdio 传输与分帧交给 `LspJsonRpcConnection`。
 *
 * 诊断（2026-09-19 新增）：`textDocument/publishDiagnostics` 是**通知**，原实现把它整类忽略
 * （`lspJsonRpcConnection.ts` 的 dispatch 末句「通知…忽略」）⇒ 模型改完代码拿不到任何编译错误，
 * 只能靠再跑一遍构建。现订阅该通知并缓存，`diagnostics()` 会**先强制重新分析（didOpen/didChange）
 * 再等推送**，并如实回报 `fresh` / `stale`——绝不把「没等到推送」说成「没有错误」。
 *
 * 注意：本适配器**不内置任何语言服务器**——具体服务器（typescript-language-server 等）由用户在配置里提供，
 * 这正是零依赖铁律下接入 LSP 的唯一合规方式。
 */
export class LspProcessAdapter implements LspPort {
  /** 端口名（便于调试/状态展示）：固定为 'lsp-process'。 */
  public readonly name = 'lsp-process';

  /** 默认等待诊断推送的毫秒数。 */
  public static readonly DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 5000;

  /** 当前 JSON-RPC 连接（懒启动后建立；shutdown 或握手失败后回到 undefined）。 */
  private conn: LspJsonRpcConnection | undefined;
  /** 进行中的启动握手 Promise（并发调用共享同一次启动，避免重复 spawn）。 */
  private starting: Promise<void> | undefined;
  /** 已发送过 didOpen 的文件集合（会话生命周期内每文件只 open 一次）。 */
  private readonly opened = new Set<string>();
  /** 各文件当前文档版本（didChange 需要严格递增，否则服务器会拒收）。 */
  private readonly versions = new Map<string, number>();
  /** 诊断收集器（订阅推送 → 归一化 → 缓存 → 唤醒等待者）。
   * 单独成类是因为本类当时已 609 行 / 32 方法，越过「一文件一类 + 上帝类」红线。 */
  private readonly collector = new LspDiagnosticsCollector();
  /** 等待诊断的超时毫秒数。 */
  private readonly diagnosticsTimeoutMs: number;

  public constructor(
    /** 服务器配置：启动命令/参数、工作区根 URI（LSP initialize 的 rootUri）。 */
    private readonly cfg: LspServerConfig & { readonly rootUri: string },
    /** 可选项（诊断等待超时）。 */
    options: LspProcessAdapterOptions = {},
  ) {
    this.diagnosticsTimeoutMs =
      options.diagnosticsTimeoutMs ?? LspProcessAdapter.DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
  }

  /**
   * 跳转到定义。
   *
   * @param file 目标文件绝对路径
   * @param line 编辑器 1-based 行号
   * @param character 编辑器 1-based 列号
   * @returns 定义位置列表（1-based 坐标）
   */
  public async definition(
    file: string,
    line: number,
    character: number,
  ): Promise<readonly LspLocation[]> {
    return this.requestNav('textDocument/definition', file, line, character);
  }

  /**
   * 查找引用（含声明处）。
   *
   * @param file 目标文件绝对路径
   * @param line 编辑器 1-based 行号
   * @param character 编辑器 1-based 列号
   * @returns 引用位置列表（1-based 坐标）
   */
  public async references(
    file: string,
    line: number,
    character: number,
  ): Promise<readonly LspLocation[]> {
    return this.requestNav('textDocument/references', file, line, character, {
      includeDeclaration: true,
    });
  }

  /**
   * 悬停文档。
   *
   * @param file 目标文件绝对路径
   * @param line 编辑器 1-based 行号
   * @param character 编辑器 1-based 列号
   * @returns 文档文本；无文档时返回 undefined
   */
  public async hover(file: string, line: number, character: number): Promise<string | undefined> {
    await this.ensureStarted();
    await this.didOpen(file);
    const result = await this.requireConn().request('textDocument/hover', {
      textDocument: { uri: LspUri.fileToUri(file) },
      position: { line: line - 1, character: character - 1 },
    });
    return LspResultNormalizer.hoverText(result);
  }

  /**
   * 列出文档符号（层级式压平为带缩进的清单）。
   *
   * 用途与 `definition` 互补：跳转的前提是**已经知道符号在哪一行**；当模型刚接手
   * 一个陌生文件时，它连行号都没有，只能靠通读整文件。`documentSymbol` 让它先拿到
   * 目录，再决定读哪一段——这是省上下文最直接的一步。
   *
   * @param file 目标文件绝对路径
   * @returns 符号清单（1-based 坐标、已压平、最多 500 条）；服务器返回空/非法时为空数组
   */
  public async symbols(file: string): Promise<readonly LspSymbol[]> {
    await this.ensureStarted();
    await this.didOpen(file);
    const result = await this.requireConn().request('textDocument/documentSymbol', {
      textDocument: { uri: LspUri.fileToUri(file) },
    });
    return LspSymbolNormalizer.normalize(result, file);
  }

  /**
   * 在工作区范围内按名字查符号（`workspace/symbol`）。
   *
   * 与 {@link LspProcessAdapter.symbols} 的关键差别：**不需要先知道文件**，因此也不发 didOpen
   * （全局查询依赖服务器自己的索引，打开某个文件反而缩小了它的视野）。服务器索引未就绪时应答
   * 可能偏少，这是服务器侧行为，本层如实返回，不猜测、不补全。
   *
   * 服务器没给区间的符号（LSP 3.17 允许 `WorkspaceSymbol.location` 只有 `uri`）按文件起点
   * 呈现——名字与文件是真的，位置只是不精确；连 URI 都没有的条目才跳过。
   *
   * @param query 符号名查询串（原样下发；空串是否等价于「全部」由服务器决定）
   * @returns 工作区符号清单（1-based 坐标、已归一两种上游形状、最多 500 条）；无结果为空数组
   */
  public async workspaceSymbols(query: string): Promise<readonly LspWorkspaceSymbol[]> {
    await this.ensureStarted();
    const result = await this.requireConn().request('workspace/symbol', { query });
    return LspSymbolNormalizer.normalizeWorkspace(result, `(工作区查询: ${query})`);
  }

  /**
   * 取指定区间的代码操作（快速修复/重构建议）。
   *
   * **只呈现，不应用**：返回的是「改哪儿、改成什么」，落盘必须由上层经审批/沙箱决定。
   * 请求里的 `context.diagnostics` 固定传空数组——本适配器不把诊断作为前置条件
   * （那会让 `quickfix` 类操作在「尚未跑诊断」时整批消失，而 `refactor` 类根本不需要它）。
   * 代价是：纯靠诊断触发的服务器可能少给几条建议，属可接受的**宁可少给、不给错**。
   *
   * @param file 目标文件绝对路径
   * @param range 编辑器 1-based 区间（内部转 LSP 0-based）
   * @returns 归一化后的操作清单（最多 50 条、每条最多 20 处编辑）；无结果为空数组
   */
  public async codeActions(file: string, range: LspRange): Promise<readonly LspCodeAction[]> {
    await this.ensureStarted();
    await this.didOpen(file);
    const result = await this.requireConn().request('textDocument/codeAction', {
      textDocument: { uri: LspUri.fileToUri(file) },
      range: {
        start: { line: range.start.line - 1, character: range.start.character - 1 },
        end: { line: range.end.line - 1, character: range.end.character - 1 },
      },
      context: { diagnostics: [] },
    });
    return LspCodeActionNormalizer.normalize(result);
  }

  /**
   * 取文档诊断：先做一次文档同步（首开 didOpen / 之后 didChange）强制服务器重新分析，
   * 再等待该文件的 `publishDiagnostics`；超时则返回缓存并标记 `stale`。
   *
   * @param file 目标文件绝对路径
   * @returns 诊断报告（含新鲜度：`fresh` = 本次确实收到推送，`stale` = 只拿到缓存）
   */
  public async diagnostics(file: string): Promise<LspDiagnosticReport> {
    await this.ensureStarted();
    await this.syncDocument(file);
    const received = await this.collector.awaitPublish(file, this.diagnosticsTimeoutMs);
    return {
      file,
      diagnostics: this.collector.cached(file),
      status: received ? 'fresh' : 'stale',
    };
  }

  /**
   * 关闭会话：shutdown → exit 并终止子进程；幂等（未启动直接返回）。
   *
   * @returns 关闭完成
   */
  public async shutdown(): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    this.starting = undefined;
    this.opened.clear();
    this.versions.clear();
    this.collector.clear();
    if (conn === undefined) {
      return;
    }
    await conn.close();
  }

  // ---- 内部：LSP 导航请求（definition / references）共用骨架 ----

  /** 导航类请求共用骨架：启动 → didOpen → 请求 → 归一化。
   * @param method LSP 导航方法名（textDocument/definition 或 textDocument/references）。
   * @param file 目标文件绝对路径（内部转 file:// URI）。
   * @param line 编辑器 1-based 行号（内部转 LSP 0-based）。
   * @param character 编辑器 1-based 列号（内部转 LSP 0-based）。
   * @param context 可选请求上下文（references 用 includeDeclaration 控制是否含声明处）。
   * @returns 归一化后的位置列表（1-based 坐标、文件路径）；服务器返回空/非法时为空数组。
   */
  private async requestNav(
    method: 'textDocument/definition' | 'textDocument/references',
    file: string,
    line: number,
    character: number,
    context?: { readonly includeDeclaration: boolean },
  ): Promise<readonly LspLocation[]> {
    await this.ensureStarted();
    await this.didOpen(file);
    const params = {
      textDocument: { uri: LspUri.fileToUri(file) },
      position: { line: line - 1, character: character - 1 },
      ...(context !== undefined ? { context } : {}),
    };
    const result = await this.requireConn().request(method, params);
    return LspResultNormalizer.toLocations(result);
  }

  /** 取当前连接；未启动即抛错（调用方须先 ensureStarted）。
   * @returns 已建立的 JSON-RPC 连接。
   */
  private requireConn(): LspJsonRpcConnection {
    if (this.conn === undefined) {
      throw new Error('LSP 连接尚未建立');
    }
    return this.conn;
  }

  // ---- 内部：进程生命周期 ----

  /** 确保会话已就绪：已就绪直接返回；已死亡抛错；否则懒启动并握手。
   * @returns 无返回值。
   */
  private async ensureStarted(): Promise<void> {
    if (this.starting !== undefined) {
      await this.starting;
      return;
    }
    if (this.conn !== undefined) {
      if (this.conn.isDead) {
        throw new Error('LSP 会话已终止（进程异常退出），请重建适配器');
      }
      return;
    }
    const starting = this.startConnection();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) {
        this.starting = undefined;
      }
    }
  }

  /** spawn 子进程并完成 initialize/initialized 握手；失败则回收并允许下次重试。
   * @returns 无返回值。
   */
  private async startConnection(): Promise<void> {
    this.opened.clear();
    const conn = new LspJsonRpcConnection({
      command: this.cfg.serverCommand,
      args: this.cfg.serverArgs ?? [],
      answerServerRequest: (method) => this.answerServerRequest(method),
      // 订阅服务器推送：诊断是被「推」过来的，不订阅就永远拿不到（原实现整类忽略）。
      onNotification: (method, params) => this.onServerNotification(method, params),
    });
    this.conn = conn;
    conn.start();
    try {
      await conn.request('initialize', {
        processId: process.pid ?? 0,
        rootUri: this.cfg.rootUri,
        // 只声明本适配器**确实会发**的请求能力（workspaceSymbol 于 2026-09-19 补齐），
        // 不虚报 documentSymbol/codeAction 之外的项，避免服务器按虚假能力改变应答行为。
        capabilities: { workspace: { symbol: { dynamicRegistration: false } } },
      });
      conn.notify('initialized', {});
    } catch (error) {
      conn.forceClose();
      this.conn = undefined;
      throw error;
    }
  }

  // ---- 内部：文档同步 ----

  /** 首次见到某文件时发 didOpen（读盘失败则发空文本，让服务器自行解析）。
   * @param file 要打开的文件绝对路径（转 URI 后随 languageId/version/text 一起下发）。
   
 * @returns 无返回值。
*/
  private async didOpen(file: string): Promise<void> {
    if (this.opened.has(file)) {
      return;
    }
    this.opened.add(file);
    this.versions.set(file, 1);
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // 读不到内容也照常发 didOpen（空文本），让服务器按磁盘文件自行解析。
    }
    this.requireConn().notify('textDocument/didOpen', {
      textDocument: {
        uri: LspUri.fileToUri(file),
        languageId: LspResultNormalizer.languageId(file),
        version: 1,
        text,
      },
    });
  }

  /**
   * 强制同步文档内容以触发重新分析：首开用 didOpen（版本 1），之后用 didChange（版本严格递增）。
   *
   * 为什么必须递增版本：LSP 规定 `didChange` 的 `version` 必须大于上一次，否则服务器可拒收
   * 或忽略 —— 症状正是「诊断永远停在第一次的结果」，比报错更难查。
   *
   * @param file 目标文件绝对路径
   * @returns 同步完成
   */
  private async syncDocument(file: string): Promise<void> {
    if (!this.opened.has(file)) {
      await this.didOpen(file);
      return;
    }
    const version = (this.versions.get(file) ?? 1) + 1;
    this.versions.set(file, version);
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // 读不到内容时发空文本，交由服务器按磁盘状态判定。
    }
    this.requireConn().notify('textDocument/didChange', {
      textDocument: { uri: LspUri.fileToUri(file), version },
      contentChanges: [{ text }],
    });
  }

  // ---- 内部：诊断订阅 ----

  /**
   * 处理服务器推送的通知：交给诊断收集器消费（非诊断类通知被其忽略）。
   *
   * @param method 通知方法名
   * @param params 通知参数
   * @returns 无返回值
   */
  private onServerNotification(method: string, params: unknown): void {
    this.collector.accept(method, params);
  }

  // ---- 内部：服务器请求应答 ----

  /** 尽量应答服务器 → 客户端请求，避免握手卡死。
   * @param method 服务器发来的请求方法名。
   * @returns 该方法的最小合法应答（注册能力/配置/消息请求各给空实现），未知方法返回空对象。
   */
  private answerServerRequest(method: string): unknown {
    if (method === 'client/registerCapability') {
      return {};
    }
    if (method === 'workspace/configuration') {
      return [];
    }
    if (method === 'window/showMessageRequest') {
      return { title: '' };
    }
    return {};
  }

  // ---- 内部：结果归一化已抽到 LspResultNormalizer（纯值转换，与本类状态无关）----
}
