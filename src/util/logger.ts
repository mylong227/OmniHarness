/**
 * 零依赖结构化日志基座（P1 可观测性补课，续十七）。
 *
 * 设计约束：仅用 node: 内置（async_hooks），不引入任何运行时依赖。
 * - 日志以 JSON 行写入 stderr，保证 stdout 仅承载「最终答案」（CLI 契约）。
 * - 级别：debug < info < warn < error，受 `OMNI_LOG_LEVEL` 环境变量控制（默认 info）。
 * - traceId：通过 AsyncLocalStorage 在当前异步上下文自动传播，无需逐层透传形参；
 *   也可由 `X-Trace-Id` 请求头注入，便于跨服务串联。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const traceStorage = new AsyncLocalStorage<string | undefined>();

function envLevel(): LogLevel {
  const v = (process.env['OMNI_LOG_LEVEL'] ?? 'info').toLowerCase();
  return v in ORDER ? (v as LogLevel) : 'info';
}

export type LogSink = (line: string) => void;

export class Logger {
  constructor(
    private readonly minLevel: LogLevel = envLevel(),
    private readonly sink: LogSink = (line) => {
      process.stderr.write(line + '\n');
    },
  ) {}

  /** 当前异步上下文的 traceId（无则为 undefined）。 */
  static get currentTrace(): string | undefined {
    return traceStorage.getStore();
  }

  /** 在带 traceId 的上下文中执行 fn，期间所有日志自动携带该 traceId。 */
  withTrace<T>(traceId: string | undefined, fn: () => T): T {
    return traceStorage.run(traceId, fn);
  }

  /** 为传入的 traceId 生成 UUID（无则为随机值），供 HTTP 层统一建号。 */
  static nextTraceId(provided?: string | undefined): string {
    return provided && provided.length > 0 ? provided : randomUUID();
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const trace = traceStorage.getStore();
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (trace !== undefined) entry['traceId'] = trace;
    if (fields !== undefined) Object.assign(entry, fields);
    this.sink(JSON.stringify(entry));
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }
}

/** 默认单例：级别取自环境变量，写入 stderr。 */
export const log = new Logger();
