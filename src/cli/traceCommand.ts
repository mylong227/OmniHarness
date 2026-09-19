/**
 * trace 子命令（TraceCommand）——只读自省「我刚做了什么」的 CLI 入口。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`ports/intelligence/traceIntrospection.ts`（端口）与
 * `adapters/telemetry/readonlyTraceReader.ts`（只读投影）有实现、有单测，但生产入口不可达。
 * 本命令与 `trace.read` RPC **共用同一个服务（SessionTraceService）与同一个端口实现**
 * （ReadonlyTraceReader），保证两条入口语义一致、只有一处实现。
 *
 * 只读纪律：本命令只读会话存档（`<storage-dir>/<sessionId>.jsonl`），不写、不改、不建目录。
 * 存储后端说明：读的是 jsonl 存档（与 `session list --storage-dir` 同一口径）；memory/sqlite
 * 后端不落该目录时如实报告「会话未找到或无 trace」，不伪造条目。
 */
import { join, resolve } from 'node:path';
import { SessionEventReader } from '../adapters/telemetry/sessionEventReader.js';
import { SessionTraceService } from '../server/services/sessionTraceService.js';
import type {
  TraceEntry,
  TraceReadRequest,
  TraceReadResult,
} from '../ports/intelligence/traceIntrospection.js';
import { CliArgReader } from './cliArgReader.js';

/** 用法提示。 */
const USAGE =
  '用法: omniharness trace read --session ID [--limit N] [--kind K] ' +
  '[--storage-dir DIR] [--json]\n';

/** 默认会话存档子目录（相对工作区；与存储层 jsonl 后端缺省一致）。 */
const DEFAULT_SESSIONS_DIR = join('.omniharness', 'sessions');

/** TraceCommand 依赖（缺省实现直接读会话存档）。 */
export interface TraceCommandDeps {
  /** 会话事件源工厂：给定存储目录返回事件读取器。 */
  readonly createReader?: ((storageDir: string) => SessionEventReader) | undefined;
  /** 输出通道（缺省 process.stdout；单测注入以断言输出）。 */
  readonly write?: ((text: string) => void) | undefined;
  /** 错误通道（缺省 process.stderr）。 */
  readonly writeError?: ((text: string) => void) | undefined;
  /** 工作区根（相对 `--storage-dir` 的基准；缺省进程工作目录）。 */
  readonly workspace?: string | undefined;
}

/** trace 子命令：只读自省会话事件流。 */
export class TraceCommand {
  /** 会话事件源工厂。 */
  private readonly createReader: (storageDir: string) => SessionEventReader;
  /** 输出通道。 */
  private readonly write: (text: string) => void;
  /** 错误通道。 */
  private readonly writeError: (text: string) => void;
  /** 工作区根。 */
  private readonly workspace: string;

  /**
   * @param deps 事件源工厂、输出/错误通道与工作区根（均可缺省）
   */
  public constructor(deps: TraceCommandDeps = {}) {
    this.createReader = deps.createReader ?? ((storageDir) => new SessionEventReader(storageDir));
    this.write = deps.write ?? ((text) => process.stdout.write(text));
    this.writeError = deps.writeError ?? ((text) => process.stderr.write(text));
    this.workspace = deps.workspace ?? process.cwd();
  }

  /**
   * 执行 trace 子命令。
   * @param args 子命令参数（已去掉 `trace`，首元素为子命令名；当前仅 `read`）
   * @returns 进程退出码（0 成功 / 1 会话未找到或读取失败 / 2 用法错误）
   */
  public async run(args: readonly string[]): Promise<number> {
    if (args[0] !== 'read') {
      this.write(USAGE);
      return 2;
    }
    const reader = new CliArgReader(args.slice(1));
    const session = reader.value('--session');
    if (session === undefined || session.trim() === '') {
      this.write(USAGE);
      return 2;
    }
    const workspace = this.workspace;
    const storageDirArg = reader.value('--storage-dir') ?? DEFAULT_SESSIONS_DIR;
    // 用 resolve 而非 join：`join` 不认右侧的绝对路径（会把盘符再拼一次），
    // 而 `--storage-dir D:\sessions` 这类显式绝对路径必须原样生效。
    const storageDir = resolve(workspace, storageDirArg);
    const source = this.createReader(storageDir);
    const service = new SessionTraceService({
      replay: (id) => source.load(id),
      // 存档读取器对「文件缺失」与「零事件」都回空数组，故存在性判定取「能否读出事件」。
      exists: async (id) => (await source.load(id)).length > 0,
    });
    await service.load(session);
    const request: TraceReadRequest = { session, ...this.filterOf(reader) };
    const result = service.read(request);
    if (result.error !== undefined) {
      this.writeError(`[omniharness] trace 读取失败: ${result.error}\n`);
      return 1;
    }
    this.render(result, args.includes('--json'));
    return 0;
  }

  /**
   * 解析 limit / kind 过滤（非法数字按未提供处理，与 audit 的宽松口径一致）。
   * @param reader 参数读取器
   * @returns 过滤条件（未提供时不带对应键，满足 exactOptionalPropertyTypes）
   */
  private filterOf(reader: CliArgReader): { limit?: number; kind?: string } {
    const raw = reader.value('--limit');
    const limit = raw === undefined ? undefined : Number(raw);
    const kind = reader.value('--kind');
    return {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      ...(kind !== undefined && kind !== '' ? { kind } : {}),
    };
  }

  /**
   * 渲染结果：json 为单行 JSON（机器可读），否则 TSV 表（人读，含稳定 seq）。
   * @param result trace 读取结果
   * @param asJson 是否 JSON 输出
   * @returns 无返回值
   */
  private render(result: TraceReadResult, asJson: boolean): void {
    if (asJson) {
      this.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const lines = [`session\t${result.session}\t${String(result.count)} 条`];
    for (const entry of result.entries) {
      lines.push(TraceCommand.row(entry));
    }
    this.write(`${lines.join('\n')}\n`);
  }

  /**
   * 单条条目渲染为 TSV 行。
   * @param entry 只读 trace 条目
   * @returns `seq\tat\tkind\tsummary` 一行
   */
  private static row(entry: TraceEntry): string {
    return `${String(entry.seq)}\t${entry.at}\t${entry.kind}\t${entry.summary}`;
  }
}
