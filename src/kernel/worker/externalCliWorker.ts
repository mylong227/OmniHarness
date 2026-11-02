import { CliWorker } from './cliWorker.ts';

/**
 * @beta
 * 外部 CLI worker 规格：`<name>=<command line>`。
 *
 * 与任何厂商解耦：用户传什么命令，就以什么命令执行任务（任务文本作为最后一个参数追加）。
 * 适用于接受「任务文本」位置参数的外部 agent CLI；也支持 `claude -p` 这类需要固定前置
 * 参数的命令行（`--worker-external c="claude -p"` ⇒ `claude -p "<task>"`）。
 */
export interface ExternalCliWorkerSpec {
  /** worker 名（`=` 左侧；仅字母/数字/下划线/连字符）。 */
  readonly name: string;
  /** 可执行命令（命令行第一个 token）。 */
  readonly command: string;
  /** 固定前置参数（命令行其余 token，按原顺序放在任务文本之前）。 */
  readonly args: readonly string[];
}

/**
 * 外部 CLI worker 工厂（纯解析 + 构造，无状态）。
 */
export class ExternalCliWorker {
  /** worker 名字允许的字符（避免与注册表键/事件字段冲突）。 */
  private static readonly NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

  /**
   * 解析 `NAME=COMMAND LINE` 规格。
   *
   * 命令行按「空白分隔 + 单/双引号包裹」做**纯分词**：不展开变量、不做 glob、不调用 shell。
   * 反斜杠只在转义空白/引号/反斜杠时生效，因此 Windows 路径（`D:\a\b`）原样保留。
   * @param spec CLI 传入的原始规格。
   * @returns 解析后的规格（命令 + 固定前置参数）。
   * @throws 格式非法 / 名字非法 / 命令为空 / 引号未闭合时抛出（fail-closed）。
   */
  public static parse(spec: string): ExternalCliWorkerSpec {
    const at = spec.indexOf('=');
    if (at <= 0) {
      throw new Error(`--worker-external 需要 NAME=COMMAND 形式，收到：${spec}`);
    }
    const name = spec.slice(0, at).trim();
    if (!ExternalCliWorker.NAME_PATTERN.test(name)) {
      throw new Error(`--worker-external 名字只能含字母/数字/下划线/连字符：${name}`);
    }
    const tokens = ExternalCliWorker.tokenize(spec.slice(at + 1));
    const command = tokens[0];
    if (command === undefined || command === '') {
      throw new Error(`--worker-external 的命令不能为空：${spec}`);
    }
    return { name, command, args: tokens.slice(1) };
  }

  /**
   * 把规格构造成通用 CLI worker。
   *
   * 任务文本作为**独立 argv** 追加，不经 shell 拼接；Windows 上沿用 {@link CliWorker}
   * 的 npm 垫片安全解析（不把任务交给 cmd 解析）。
   * @param spec 已解析的规格。
   * @returns 可直接注册进 `WorkerRegistry` 的 worker。
   */
  public static create(spec: ExternalCliWorkerSpec): CliWorker {
    return new CliWorker({
      name: `external:${spec.name}`,
      command: spec.command,
      args: (task) => [...spec.args, task],
      shell: process.platform === 'win32',
    });
  }

  /**
   * 纯分词（不执行 shell 语义）。
   * @param input `=` 右侧的命令行。
   * @returns token 列表；空输入返回空数组。
   * @throws 引号未闭合时抛出。
   */
  private static tokenize(input: string): string[] {
    const out: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let hasToken = false;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i]!;
      if (quote !== undefined) {
        if (ch === quote) {
          quote = undefined;
          continue;
        }
        if (ch === '\\' && quote === '"' && i + 1 < input.length) {
          const next = input[i + 1]!;
          if (next === '"' || next === '\\') {
            current += next;
            i += 1;
            continue;
          }
        }
        current += ch;
        hasToken = true;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        hasToken = true;
        continue;
      }
      if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
          current += next;
          i += 1;
          hasToken = true;
          continue;
        }
        current += ch;
        hasToken = true;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        if (hasToken) {
          out.push(current);
          current = '';
          hasToken = false;
        }
        continue;
      }
      current += ch;
      hasToken = true;
    }
    if (quote !== undefined) {
      throw new Error(`--worker-external 命令行的引号未闭合：${input}`);
    }
    if (hasToken) out.push(current);
    return out;
  }
}
