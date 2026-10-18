import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  FailureReflection,
  FailureReflectionPort,
} from '../../ports/memory/failureReflection.ts';

/** 存储选项。 */
export interface FailureReflectionStoreOptions {
  /** 最多保留条数（默认 50；超出淘汰最旧）。 */
  readonly maxEntries?: number;
  /** 可注入时钟（测试用）。 */
  readonly now?: (() => Date) | undefined;
  /** 可注入文件路径（缺省 `<workspace>/.omniharness/failure-reflections.jsonl`）。 */
  readonly path?: string | undefined;
}

/**
 * 文件版失败反思存储（工作区内 JSONL；原子写；有界）。
 *
 * 为什么放工作区而不是全局：失败与文件/测试命令强相关，跨项目复用会制造错误暗示；
 * 为什么是有界 JSONL：满足「可读、可手工删除、不会随会话无限增长」三件事。
 */
export class FailureReflectionStore implements FailureReflectionPort {
  /** 最多保留条数。 */
  private readonly maxEntries: number;
  /** 时钟。 */
  private readonly now: () => Date;
  /** 存储路径。 */
  private readonly path: string;

  /**
   * @param workspaceRoot 工作区根。
   * @param options 存储选项。
   */
  public constructor(workspaceRoot: string, options: FailureReflectionStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 50));
    this.now = options.now ?? (() => new Date());
    this.path = options.path ?? join(workspaceRoot, '.omniharness', 'failure-reflections.jsonl');
  }

  /**
   * 记录一条失败反思；重复内容不重复写。
   * @param input 反思内容
   * @returns 无返回值
   */
  public async remember(input: Omit<FailureReflection, 'id' | 'at'>): Promise<void> {
    const entries = await this.read();
    const signature = FailureReflectionStore.signatureOf(input);
    if (entries.some((entry) => FailureReflectionStore.signatureOf(entry) === signature)) {
      return;
    }
    const entry: FailureReflection = {
      id: randomUUID(),
      toolName: input.toolName,
      targets: [...input.targets],
      command: input.command,
      exitCode: input.exitCode,
      digest: input.digest.slice(0, 2_000),
      at: this.now().toISOString(),
    };
    const next = [...entries, entry].slice(-this.maxEntries);
    await this.write(next);
  }

  /**
   * 召回与目标文件重叠的最近反思。
   * @param input 目标文件与上限
   * @returns 最近的反思
   */
  public async recall(input: {
    readonly targets: readonly string[];
    readonly limit?: number;
  }): Promise<readonly FailureReflection[]> {
    if (input.targets.length === 0) return [];
    const limit = Math.min(5, Math.max(1, Math.floor(input.limit ?? 2)));
    const entries = await this.read();
    return entries
      .filter((entry) => entry.targets.some((target) => input.targets.includes(target)))
      .slice(-limit)
      .reverse();
  }

  /**
   * 读取全部条目（坏行跳过；文件不存在返回空）。
   * @returns 反思数组
   */
  private async read(): Promise<FailureReflection[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: FailureReflection[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as FailureReflection;
        if (FailureReflectionStore.isEntry(row)) out.push(row);
      } catch {
        // 坏行跳过：反思是增强，不是主状态。
      }
    }
    return out;
  }

  /**
   * 原子写入（先写 tmp 再 rename）。
   * @param entries 条目
   * @returns 无返回值
   */
  private async write(entries: readonly FailureReflection[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tmp, this.path);
  }

  /**
   * 运行期形状校验（手改文件也可能坏）。
   * @param value 反序列化值
   * @returns 可用时为 true
   */
  private static isEntry(value: unknown): value is FailureReflection {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Partial<FailureReflection>;
    return (
      typeof row.id === 'string' &&
      typeof row.toolName === 'string' &&
      Array.isArray(row.targets) &&
      row.targets.every((target) => typeof target === 'string') &&
      typeof row.command === 'string' &&
      (row.exitCode === null || typeof row.exitCode === 'number') &&
      typeof row.digest === 'string' &&
      typeof row.at === 'string'
    );
  }

  /**
   * 去重签名（不看时间/id）。
   * @param input 反思
   * @returns 签名
   */
  private static signatureOf(input: Omit<FailureReflection, 'id' | 'at'>): string {
    return [
      input.toolName,
      [...input.targets].sort().join(','),
      input.command,
      String(input.exitCode),
      input.digest.slice(0, 200),
    ].join('\u0000');
  }
}
