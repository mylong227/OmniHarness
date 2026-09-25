/**
 * LSP 诊断收集器（`LspProcessAdapter` 的内部协作者）。
 *
 * 存在的理由（2026-09-19）：补齐诊断能力后 `LspProcessAdapter` 越过上帝类线（609 代码行 / 32 方法）。
 * 而「JSON-RPC 请求-响应（导航）」与「通知订阅 → 归一化 → 缓存 → 唤醒等待者（诊断）」本就互不依赖，
 * 拆开后两者各自内聚，也各自可独立演进。
 *
 * **定时器纪律（本仓真血案换来的铁律）**：等待类定时器**刻意不 `unref()`**——
 * 有界等待一旦 unref，一旦「除该计时器外无其他句柄」事件循环就提前排空，到点也不触发 ⇒
 * 守卫在被需要的那一刻静默失效。这里靠 `clear()` / 超时路径显式清理，不靠 unref。
 */
import type { LspDiagnostic, LspDiagnosticSeverity } from '../../ports/tool/lsp.js';
import { LspUri } from './lspUri.js';

/** 等待推送诊断的登记项。 */
interface DiagnosticsWaiter {
  /** 关注的文件绝对路径。 */
  readonly file: string;
  /** 收到推送时回调 true。 */
  readonly resolve: (received: boolean) => void;
  /** 超时定时器（**刻意不 `unref()`**）。 */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 诊断收集器：订阅 `publishDiagnostics` 推送 → 归一化 → 缓存 → 唤醒等待者。 */
export class LspDiagnosticsCollector {
  /** 诊断推送的 LSP 通知方法名。 */
  public static readonly NOTIFICATION_METHOD = 'textDocument/publishDiagnostics';

  /** 各文件最近一次收到的诊断（键为文件绝对路径）。 */
  private readonly published = new Map<string, readonly LspDiagnostic[]>();

  /** 等待某文件推送诊断的登记项。 */
  private readonly waiters: DiagnosticsWaiter[] = [];

  /**
   * 接收一条服务器通知；仅消费诊断推送。
   *
   * @param method 通知方法名
   * @param params 通知参数
   * @returns 该通知是否被本收集器消费（false = 与诊断无关，调用方可忽略）
   */
  public accept(method: string, params: unknown): boolean {
    if (method !== LspDiagnosticsCollector.NOTIFICATION_METHOD) {
      return false;
    }
    const payload = params as { readonly uri?: unknown; readonly diagnostics?: unknown } | null;
    const uri = payload?.uri;
    if (typeof uri !== 'string') {
      return false;
    }
    const file = LspUri.uriToFile(uri);
    this.published.set(file, LspDiagnosticsCollector.toDiagnostics(file, payload?.diagnostics));
    this.settle(file);
    return true;
  }

  /**
   * 等待某文件的下一次诊断推送。
   *
   * @param file 目标文件绝对路径
   * @param timeoutMs 等待窗口毫秒数
   * @returns 窗口内收到推送为 true；超时为 false（调用方据此标记 stale，绝不当作「无错误」）
   */
  public awaitPublish(file: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const entry: DiagnosticsWaiter = {
        file,
        resolve: (received: boolean) => resolve(received),
        timer: setTimeout(() => {
          this.removeWaiter(entry);
          resolve(false);
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }

  /**
   * 取某文件的缓存诊断。
   *
   * @param file 目标文件绝对路径
   * @returns 缓存诊断；从未收到推送时为空数组
   */
  public cached(file: string): readonly LspDiagnostic[] {
    return this.published.get(file) ?? [];
  }

  /**
   * 清空缓存并释放全部等待者（会话关闭时调用）。
   *
   * @returns 无返回值
   */
  public clear(): void {
    this.published.clear();
    while (this.waiters.length > 0) {
      const waiter = this.waiters.pop();
      if (waiter === undefined) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }

  /**
   * 唤醒某文件的全部等待者（收到推送时调用）。
   *
   * @param file 目标文件绝对路径
   * @returns 无返回值
   */
  private settle(file: string): void {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (waiter === undefined || waiter.file !== file) {
        continue;
      }
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  /**
   * 摘除单个等待者（超时路径）。
   *
   * @param entry 要摘除的登记项
   * @returns 无返回值
   */
  private removeWaiter(entry: DiagnosticsWaiter): void {
    const index = this.waiters.indexOf(entry);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }

  /**
   * 归一化 LSP `Diagnostic[]`（0-based → 1-based，并映射严重度）。
   *
   * @param file 目标文件绝对路径
   * @param raw 服务器推送的原始诊断数组
   * @returns 归一化后的诊断列表；结构非法条目逐个剔除
   */
  private static toDiagnostics(file: string, raw: unknown): readonly LspDiagnostic[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: LspDiagnostic[] = [];
    for (const item of raw) {
      const diagnostic = LspDiagnosticsCollector.toDiagnostic(file, item);
      if (diagnostic !== undefined) {
        out.push(diagnostic);
      }
    }
    return out;
  }

  /**
   * 归一化单条诊断。
   *
   * @param file 目标文件绝对路径
   * @param item 服务器推送的单条原始诊断
   * @returns 归一化后的诊断；结构非法时为 undefined
   */
  private static toDiagnostic(file: string, item: unknown): LspDiagnostic | undefined {
    if (item === null || typeof item !== 'object') {
      return undefined;
    }
    const raw = item as {
      readonly range?: {
        readonly start?: { readonly line?: number; readonly character?: number };
        readonly end?: { readonly line?: number; readonly character?: number };
      };
      readonly severity?: unknown;
      readonly message?: unknown;
      readonly source?: unknown;
      readonly code?: unknown;
    };
    const start = raw.range?.start;
    const end = raw.range?.end;
    if (
      typeof start?.line !== 'number' ||
      typeof start.character !== 'number' ||
      typeof end?.line !== 'number' ||
      typeof end.character !== 'number' ||
      typeof raw.message !== 'string'
    ) {
      return undefined;
    }
    return {
      file,
      range: {
        start: { line: start.line + 1, character: start.character + 1 },
        end: { line: end.line + 1, character: end.character + 1 },
      },
      severity: LspDiagnosticsCollector.severityOf(raw.severity),
      message: raw.message,
      ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
      ...(typeof raw.code === 'string' || typeof raw.code === 'number'
        ? { code: String(raw.code) }
        : {}),
    };
  }

  /**
   * 映射 LSP `DiagnosticSeverity`（1=Error 2=Warning 3=Information 4=Hint）。
   *
   * @param raw 服务器给出的严重度
   * @returns 归一化严重度；缺失或未知按 warning 处理
   */
  private static severityOf(raw: unknown): LspDiagnosticSeverity {
    if (raw === 1) {
      return 'error';
    }
    if (raw === 3) {
      return 'info';
    }
    if (raw === 4) {
      return 'hint';
    }
    return 'warning';
  }
}
