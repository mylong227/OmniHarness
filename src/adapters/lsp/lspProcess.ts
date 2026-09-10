import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { LspLocation, LspPort, LspServerConfig } from '../../ports/lsp.js';
import { fileToUri, uriToFile } from '../../lsp/lspUri.js';

/** JSON-RPC 2.0 消息（宽松结构，仅取我们需要的字段）。 */
interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** 单个挂起请求的回调登记。 */
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 请求超时（ms）：服务器无响应即 fail-closed 上抛，绝不干等。 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * @beta
 * 进程级 LSP 适配器（对标 codex 的 stdio 桥接）：
 * 外启语言服务器子进程，用 LSP 协议（stdio JSON-RPC，Content-Length 分帧）通信。
 *
 * - **零依赖**：仅用 Node 内置 `node:child_process` / `node:fs` / `node:url`，不新增任何 npm 包。
 * - **懒启动**：首个语义调用时才 spawn 子进程并完成 initialize 握手，避免无谓常驻。
 * - **坐标转换**：工具/CLI 给 1-based 编辑器坐标，本适配器内部转 LSP 0-based，返回时再转回 1-based。
 * - **fail-closed**：握手/请求超时、协议错误、进程异常退出均上抛，由工具层转成可读错误文本。
 *
 * 注意：本适配器**不内置任何语言服务器**——具体服务器（typescript-language-server 等）由用户在配置里提供，
 * 这正是零依赖铁律下接入 LSP 的唯一合规方式。
 */
export class LspProcessAdapter implements LspPort {
  public readonly name = 'lsp-process';

  private proc: ChildProcess | undefined;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private started = false;
  private dead = false;
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Set<string>();

  public constructor(private readonly cfg: LspServerConfig & { readonly rootUri: string }) {}

  /** 跳转到定义（1-based 坐标 → LSP 0-based → 结果转回 1-based）。 */
  public async definition(file: string, line: number, character: number): Promise<readonly LspLocation[]> {
    return this.requestNav('textDocument/definition', file, line, character);
  }

  /** 查找引用（含声明处）。 */
  public async references(file: string, line: number, character: number): Promise<readonly LspLocation[]> {
    return this.requestNav('textDocument/references', file, line, character, {
      includeDeclaration: true,
    });
  }

  /** 悬停文档。 */
  public async hover(file: string, line: number, character: number): Promise<string | undefined> {
    await this.ensureStarted();
    await this.didOpen(file);
    const result = await this.request('textDocument/hover', {
      textDocument: { uri: fileToUri(file) },
      position: { line: line - 1, character: character - 1 },
    });
    return this.hoverText(result);
  }

  /** 关闭会话：shutdown → exit 并终止子进程；幂等（未启动直接返回）。 */
  public async shutdown(): Promise<void> {
    if (!this.started || this.proc === undefined) {
      return;
    }
    try {
      await this.request('shutdown', {});
      this.send({ jsonrpc: '2.0', method: 'exit', params: {} });
    } catch {
      // 即便 shutdown 失败也要确保进程被回收。
    } finally {
      this.proc.kill();
      this.reset();
    }
  }

  // ---- 内部：LSP 导航请求（definition / references）共用骨架 ----

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
    const result = await this.request(method, params);
    return this.toLocations(result);
  }

  // ---- 内部：进程生命周期 ----

  private async ensureStarted(): Promise<void> {
    if (this.started) {
      if (this.dead) {
        throw new Error('LSP 会话已终止（进程异常退出），请重建适配器');
      }
      return;
    }
    this.started = true;
    this.proc = spawn(this.cfg.serverCommand, [...(this.cfg.serverArgs ?? [])], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    // 吞掉断开后的 EPIPE/ENOPIPE：shutdown 阶段可能向已退出的子进程写入，属正常竞态，不应上抛。
    this.proc.stdin?.on('error', () => undefined);
    this.proc.stdout?.on('error', () => undefined);
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.on('exit', () => {
      this.dead = true;
      this.failAll(new Error('LSP 子进程已退出'));
    });
    this.proc.on('error', (error: Error) => {
      this.dead = true;
      this.failAll(error);
    });
    try {
      await this.request('initialize', {
        processId: process.pid ?? 0,
        rootUri: this.cfg.rootUri,
        capabilities: {},
      });
      this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    } catch (error) {
      this.proc.kill();
      this.reset();
      throw error;
    }
  }

  private reset(): void {
    this.proc = undefined;
    this.started = false;
    this.dead = false;
    this.opened.clear();
    this.buf = Buffer.alloc(0);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // ---- 内部：文档同步 ----

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
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri: fileToUri(file), languageId: this.langOf(file), version: 1, text },
      },
    });
  }

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

  // ---- 内部：JSON-RPC 传输（Content-Length 分帧）----

  private send(msg: JsonRpcMessage): void {
    const stdin = this.proc?.stdin;
    if (stdin === null || stdin === undefined) {
      throw new Error('LSP 子进程 stdin 不可用');
    }
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, 'utf8');
    stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    stdin.write(payload);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(new Error('LSP 子进程已退出'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null || match[1] === undefined) {
        // 非法头：丢弃一字节，避免死循环。
        this.buf = this.buf.subarray(1);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) {
        return;
      }
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + length);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(body) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error !== undefined) {
          entry.reject(new Error(`LSP 错误: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        // 服务器 → 客户端请求（如 client/registerCapability / workspace/configuration）：尽量应答，避免握手卡死。
        this.send({ jsonrpc: '2.0', id: msg.id, result: this.answerServerRequest(msg.method) });
      }
      // 通知（publishDiagnostics / logMessage / $/progress 等）：忽略。
    }
  }

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
