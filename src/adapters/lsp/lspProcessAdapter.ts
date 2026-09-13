import { readFile } from 'node:fs/promises';
import type { LspLocation, LspPort, LspServerConfig } from '../../ports/tool/lsp.js';
import { fileToUri, uriToFile } from '../../adapters/lsp/lspUri.js';
import { LspJsonRpcConnection } from './lspJsonRpcConnection.js';

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
 * 注意：本适配器**不内置任何语言服务器**——具体服务器（typescript-language-server 等）由用户在配置里提供，
 * 这正是零依赖铁律下接入 LSP 的唯一合规方式。
 */
export class LspProcessAdapter implements LspPort {
  /** 端口名（便于调试/状态展示）：固定为 'lsp-process'。 */
  public readonly name = 'lsp-process';

  /** 当前 JSON-RPC 连接（懒启动后建立；shutdown 或握手失败后回到 undefined）。 */
  private conn: LspJsonRpcConnection | undefined;
  /** 进行中的启动握手 Promise（并发调用共享同一次启动，避免重复 spawn）。 */
  private starting: Promise<void> | undefined;
  /** 已发送过 didOpen 的文件集合（会话生命周期内每文件只 open 一次）。 */
  private readonly opened = new Set<string>();

  public constructor(
    /** 服务器配置：启动命令/参数、工作区根 URI（LSP initialize 的 rootUri）。 */
    private readonly cfg: LspServerConfig & { readonly rootUri: string },
  ) {}

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
      textDocument: { uri: fileToUri(file) },
      position: { line: line - 1, character: character - 1 },
    });
    return this.hoverText(result);
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
      textDocument: { uri: fileToUri(file) },
      position: { line: line - 1, character: character - 1 },
      ...(context !== undefined ? { context } : {}),
    };
    const result = await this.requireConn().request(method, params);
    return this.toLocations(result);
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
    });
    this.conn = conn;
    conn.start();
    try {
      await conn.request('initialize', {
        processId: process.pid ?? 0,
        rootUri: this.cfg.rootUri,
        capabilities: {},
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
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // 读不到内容也照常发 didOpen（空文本），让服务器按磁盘文件自行解析。
    }
    this.requireConn().notify('textDocument/didOpen', {
      textDocument: { uri: fileToUri(file), languageId: this.langOf(file), version: 1, text },
    });
  }

  /** 由扩展名推断 LSP languageId。
   * @param file 文件路径（取最后一个点后的扩展名，大小写不敏感）。
   * @returns 查表得到的 languageId；未知扩展名回退 'plaintext'。
   */
  private langOf(file: string): string {
    const dot = file.lastIndexOf('.');
    const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : '';
    const map: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      mjs: 'javascript',
      cjs: 'javascript',
      json: 'json',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      cc: 'cpp',
      md: 'markdown',
      sh: 'shellscript',
      yml: 'yaml',
      yaml: 'yaml',
    };
    return map[ext] ?? 'plaintext';
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

  // ---- 内部：结果归一化 ----

  /** LSP Location（0-based）→ 适配器 LspLocation（1-based）。
   * @param result 服务器原始返回（单个 Location、Location 数组或 null/undefined）。
   * @returns 转换后的位置列表（URI 转回文件路径、坐标 +1）；非法条目被逐个剔除。
   */
  private toLocations(result: unknown): LspLocation[] {
    if (result === null || result === undefined) {
      return [];
    }
    const list = Array.isArray(result) ? result : [result];
    const out: LspLocation[] = [];
    for (const item of list) {
      if (item !== null && typeof item === 'object' && 'uri' in item && 'range' in item) {
        const loc = item as {
          uri: string;
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        };
        out.push({
          uri: uriToFile(loc.uri),
          range: {
            start: { line: loc.range.start.line + 1, character: loc.range.start.character + 1 },
            end: { line: loc.range.end.line + 1, character: loc.range.end.character + 1 },
          },
        });
      }
    }
    return out;
  }

  /** 悬停返回值归一化：兼容 string / MarkupContent / MarkedString[] 三种形态。
   * @param result textDocument/hover 的原始返回。
   * @returns 拼接后的悬停文本（数组条目以换行相连）；无 contents 或形态不识别时为 undefined。
   */
  private hoverText(result: unknown): string | undefined {
    if (result === null || typeof result !== 'object') {
      return undefined;
    }
    const contents = (result as { contents?: unknown }).contents;
    if (contents === undefined) {
      return undefined;
    }
    if (typeof contents === 'string') {
      return contents;
    }
    if (Array.isArray(contents)) {
      return contents
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : entry !== null && typeof entry === 'object' && 'value' in entry
              ? String((entry as { value: unknown }).value)
              : '',
        )
        .join('\n');
    }
    if (contents !== null && typeof contents === 'object' && 'value' in contents) {
      return String((contents as { value: unknown }).value);
    }
    return undefined;
  }
}
