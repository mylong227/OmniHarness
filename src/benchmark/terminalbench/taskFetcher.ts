/**
 * Terminal-Bench 任务语料抓取器。
 *
 * 基准要能「第三方复算」，第一步是**任务语料从哪来**必须可脚本化，而不是靠人手拷。
 * 上游任务是公开仓库里的纯文本目录，所以抓取本身不需要任何容器：
 * 走 GitHub Contents API 逐任务取文件即可（有令牌时 5000 次/小时，够取几十题；
 * 无令牌 60 次/小时，适合小样本冒烟）。
 *
 * 设计取舍：
 * - **只抓 .py / .yaml / .yml / .sh / .txt / .csv / .json / 无扩展名的小文件**，
 *   跳过图片/二进制与超大文件——它们对判分无影响，抓了只会拖慢且吃盘。
 * - 已存在的文件**跳过**（可续抓），所以中途中断只需再跑一次。
 * - 抓取失败**逐文件记录**并继续，最后一并报告，不因为一个 404 丢掉整批。
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { endpointDefaults } from '../../util/endpointDefaults.js';

/** 抓取结果。 */
export interface FetchOutcome {
  /** 语料根目录（其下每个子目录即一个任务，交由 TaskParser 解析）。 */
  readonly tasksRoot: string;
  /** 成功落盘的任务名。 */
  readonly fetched: readonly string[];
  /** 失败条目（`任务/文件: 原因`）。 */
  readonly failures: readonly string[];
}

/** 抓取器可选项。 */
export interface TaskFetcherOptions {
  /** 上游仓库（`所有者/仓库`）。 */
  readonly repository?: string | undefined;
  /** 分支或标签。 */
  readonly ref?: string | undefined;
  /** 语料在仓库里的目录。 */
  readonly corpusPath?: string | undefined;
  /** GitHub 令牌（提高配额；缺省读 `GITHUB_TOKEN` / `GH_TOKEN`）。 */
  readonly token?: string | undefined;
}

/** 目录项（Contents API 的最小投影）。 */
interface ContentEntry {
  /** 名称。 */
  readonly name: string;
  /** 类型（`file` / `dir`）。 */
  readonly type: string;
  /** 字节数。 */
  readonly size: number;
  /** 下载地址（file 有）。 */
  readonly download_url: string | null;
}

/** 单文件抓取上限（字节）：超过即跳过（判分用不到，只会拖慢语料抓取）。 */
const MAX_FILE_BYTES = 512 * 1024;

/** 允许落盘扩展名（判分与题面只可能来自这些）。 */
const ALLOWED_EXTENSIONS: readonly string[] = [
  '.py',
  '.yaml',
  '.yml',
  '.sh',
  '.txt',
  '.csv',
  '.json',
  '.tsv',
  '.md',
  '.js',
  '.c',
  '.h',
  '.go',
  '.rs',
  '.java',
  '.toml',
  '.ini',
  '.cfg',
  '.sql',
  '.awk',
  '.rb',
  '.sqlite',
  '',
];

/** Terminal-Bench 任务语料抓取器。 */
export class TaskFetcher {
  /** 上游默认仓库。 */
  public static readonly DEFAULT_REPOSITORY = 'laude-institute/terminal-bench';

  /** 上游默认目录。 */
  public static readonly DEFAULT_CORPUS_PATH = 'original-tasks';

  /** 已解析出的令牌（undefined 表示未解析）。 */
  private tokenCache: string | undefined;

  /** 可选项。 */
  private readonly options: TaskFetcherOptions;

  /**
   * @param options 可选项（仓库 / 分支 / 目录 / 令牌）。
   */
  public constructor(options: TaskFetcherOptions = {}) {
    this.options = options;
  }

  /**
   * 列出上游语料里的任务名。
   *
   * @returns 任务名列表（字典序）。
   * @throws 当 API 不可达或返回异常时。
   */
  public async listTasks(): Promise<readonly string[]> {
    const entries = await this.listDirectory(this.corpusPath());
    return entries
      .filter((e) => e.type === 'dir')
      .map((e) => e.name)
      .sort();
  }

  /**
   * 抓取任务到本地目录。
   *
   * @param destRoot 目标语料根目录。
   * @param onlyTasks 只抓这些任务（缺省全抓）。
   * @param limit 最多抓多少个任务（缺省不限）。
   * @returns 抓取结果。
   */
  public async fetch(
    destRoot: string,
    onlyTasks?: readonly string[],
    limit?: number,
  ): Promise<FetchOutcome> {
    const names =
      onlyTasks !== undefined && onlyTasks.length > 0
        ? [...onlyTasks]
        : [...(await this.listTasks())];
    const selected =
      limit !== undefined && Number.isFinite(limit) && limit > 0 ? names.slice(0, limit) : names;
    const fetched: string[] = [];
    const failures: string[] = [];
    for (const name of selected) {
      const ok = await this.fetchTask(destRoot, name, failures);
      if (ok) {
        fetched.push(name);
      }
    }
    return { tasksRoot: destRoot, fetched, failures };
  }

  /**
   * 抓取单个任务目录。
   *
   * @param destRoot 目标语料根目录。
   * @param name 任务名。
   * @param failures 失败收集数组（就地追加）。
   * @returns 是否全部成功。
   */
  private async fetchTask(destRoot: string, name: string, failures: string[]): Promise<boolean> {
    const taskRoot = join(destRoot, name);
    await this.walk(this.corpusPath() + '/' + name, taskRoot, failures);
    return existsSync(join(taskRoot, 'task.yaml'));
  }

  /**
   * 递归抓取一个目录。
   *
   * @param apiPath 仓库内路径。
   * @param localDir 本地目录。
   * @param failures 失败收集数组。
   * @returns 无返回值。
   */
  private async walk(apiPath: string, localDir: string, failures: string[]): Promise<void> {
    let entries: readonly ContentEntry[];
    try {
      entries = await this.listDirectory(apiPath);
    } catch (error) {
      failures.push(`${apiPath}: ${TaskFetcher.message(error)}`);
      return;
    }
    mkdirSync(localDir, { recursive: true });
    for (const entry of entries) {
      const localPath = join(localDir, entry.name);
      if (entry.type === 'dir') {
        await this.walk(`${apiPath}/${entry.name}`, localPath, failures);
        continue;
      }
      if (!TaskFetcher.shouldFetch(entry)) {
        continue;
      }
      if (existsSync(localPath)) {
        continue;
      }
      try {
        const text = await this.download(entry);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, text, 'utf8');
      } catch (error) {
        failures.push(`${apiPath}/${entry.name}: ${TaskFetcher.message(error)}`);
      }
    }
  }

  /**
   * 是否值得落盘。
   *
   * @param entry 目录项。
   * @returns 需要抓取时为 true。
   */
  private static shouldFetch(entry: ContentEntry): boolean {
    if (entry.type !== 'file' || entry.size > MAX_FILE_BYTES) {
      return false;
    }
    const dot = entry.name.lastIndexOf('.');
    const ext = dot < 0 ? '' : entry.name.slice(dot).toLowerCase();
    return ALLOWED_EXTENSIONS.includes(ext);
  }

  /**
   * 列出仓库内某目录。
   *
   * @param apiPath 仓库内路径。
   * @returns 目录项列表。
   * @throws 当响应不是目录列表时。
   */
  private async listDirectory(apiPath: string): Promise<readonly ContentEntry[]> {
    const payload = await this.request<unknown>(`/contents/${apiPath}`);
    if (!Array.isArray(payload)) {
      throw new Error(`期望目录列表，实际收到 ${typeof payload}`);
    }
    return payload
      .map((raw) => TaskFetcher.toEntry(raw))
      .filter((e): e is ContentEntry => e !== null);
  }

  /**
   * 下载单个文件内容。
   *
   * @param entry 目录项（必须有 `download_url`）。
   * @returns 文件文本。
   * @throws 当无可下载地址或请求失败时。
   */
  private async download(entry: ContentEntry): Promise<string> {
    if (entry.download_url === null) {
      throw new Error('缺少 download_url');
    }
    const response = await fetch(entry.download_url, {
      headers: TaskFetcher.headers(this.resolveToken()),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  }

  /**
   * 调 GitHub Contents API。
   *
   * @param path API 路径（以 `/` 开头）。
   * @returns 解析后的 JSON。
   * @throws 当 HTTP 非 2xx 时。
   */
  private async request<T>(path: string): Promise<T> {
    const url = `${endpointDefaults.urlOf('githubApiBase')}/repos/${this.repository()}${path}?ref=${encodeURIComponent(this.ref())}`;
    const response = await fetch(url, {
      headers: TaskFetcher.headers(this.resolveToken()),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${TaskFetcher.hint(response.status)}`);
    }
    return (await response.json()) as T;
  }

  /**
   * 给配额类错误补一句可执行的提示。
   *
   * @param status HTTP 状态码。
   * @returns 提示文本（无建议时为空串）。
   */
  private static hint(status: number): string {
    if (status === 403) {
      return '（多半是匿名配额耗尽，设 GITHUB_TOKEN 后重试）';
    }
    if (status === 404) {
      return '（路径或分支不存在）';
    }
    return '';
  }

  /**
   * 构造请求头。
   *
   * @param token 令牌（可空）。
   * @returns 请求头。
   */
  private static headers(token: string | null): Readonly<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': 'omniharness-terminalbench',
      Accept: 'application/vnd.github+json',
    };
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * 解析令牌（显式选项 → `GITHUB_TOKEN` → `GH_TOKEN`）。
   *
   * @returns 令牌；没有为 null。
   */
  private resolveToken(): string | null {
    if (this.tokenCache === undefined) {
      const explicit = this.options.token;
      const fromEnv = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
      this.tokenCache = (explicit ?? fromEnv ?? '').trim();
    }
    return this.tokenCache === '' ? null : this.tokenCache;
  }

  /**
   * 仓库名。
   *
   * @returns `所有者/仓库`。
   */
  private repository(): string {
    return this.options.repository ?? TaskFetcher.DEFAULT_REPOSITORY;
  }

  /**
   * 分支名。
   *
   * @returns 分支或标签。
   */
  private ref(): string {
    return this.options.ref ?? 'main';
  }

  /**
   * 语料目录。
   *
   * @returns 仓库内的语料目录。
   */
  private corpusPath(): string {
    return this.options.corpusPath ?? TaskFetcher.DEFAULT_CORPUS_PATH;
  }

  /**
   * 把未知 JSON 收敛成目录项。
   *
   * @param raw API 返回的单项。
   * @returns 目录项；形状不认识时为 null。
   */
  private static toEntry(raw: unknown): ContentEntry | null {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const name = record['name'];
    const type = record['type'];
    if (typeof name !== 'string' || typeof type !== 'string') {
      return null;
    }
    const size = record['size'];
    const download = record['download_url'];
    return {
      name,
      type,
      size: typeof size === 'number' ? size : 0,
      download_url: typeof download === 'string' ? download : null,
    };
  }

  /**
   * 把未知异常收敛成一句可读原因。
   *
   * @param error 异常。
   * @returns 原因文本。
   */
  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
