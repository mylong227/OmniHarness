/**
 * 任务环境描述读取器（**容器无关**）。
 *
 * ## 为什么环境契约要容器无关
 *
 * 任务需要的运行环境是客观事实：**要哪个 Python、要装哪些包、哪些文件要落到应用根**。
 * 这份事实原先只能从构建配方（`FROM` / `RUN pip install` / `COPY` 那套）里反推，
 * 于是「跑一个任务」被绑死在「先有一个构建配方解析器」上——换宿主、换基础镜像写法都要跟着改。
 *
 * 现在环境契约改为**任务目录自己声明**：`env.json`（显式）+ Python 生态标准清单（回落）。
 * 执行侧交给宿主已有的 `uv`（`uv venv` 建解释器、`uv pip install` 装包），
 * 不需要任何容器运行时、不需要拉镜像、也不需要解析别人的构建配方。
 *
 * ## 契约（`env.json`，字段全部可选）
 *
 * ```json
 * {
 *   "python": "3.13",
 *   "pip": ["numpy==2.1.2", "-e", ".[dev]"],
 *   "apt": ["curl", "sqlite3"],
 *   "shell": ["unzip log.stack.zip"],
 *   "seeds": [{ "from": "task-deps/data.csv", "to": "." }]
 * }
 * ```
 *
 * - `python` —— 解释器版本（`uv venv --python 3.13`）；缺失交给 uv 自选。
 * - `pip`    —— **原样透传**给 `uv pip install` 的参数（包名与旗标都保留，
 *   故 `["-e", ".[dev]"]` 这类可编辑安装照样表达得出）。
 * - `apt`    —— 需声明的系统包。原生执行不装系统包，只**如实告警跳过**，绝不假装成功。
 * - `shell`  —— 构建期 shell 步骤（下载字体、解压语料、编译工具链等）。原生执行同样只如实告警。
 * - `seeds`  —— 种子文件摆放规则（`from` 相对任务目录，`to` 相对应用根）。语义对齐
 *   `COPY`：**源是文件**时 `to` 是落点路径（`to` 为目录时按源文件名落进去）；
 *   **源是目录**时把它的**内容**拷进 `to`。为空数组表示「整个任务目录兜底拷贝」。
 *
 * ## 回落：没有 `env.json` 时按标准清单推断
 *
 * 只用**容器无关、且 Python 生态本来就有**的清单（Binder / uv 同款约定）：
 * `.python-version`、`requirements.txt`、`pyproject.toml` / `setup.py`、`apt.txt`。
 * 推断出的每一条都会写进 `warnings`（不静默），因为「推断」与「任务声明」不是一回事。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一条种子文件摆放规则。 */
export interface TaskSeed {
  /** 源路径（相对任务目录）。 */
  readonly from: string;
  /** 落点（相对应用根；`.` 表示应用根本身）。 */
  readonly to: string;
}

/** 环境声明来自哪里（写进报告，让「它凭什么这么装」可复核）。 */
export type TaskEnvironmentSource = 'env.json' | 'manifests' | 'none';

/** 任务环境描述（容器无关的显式清单）。 */
export interface TaskEnvironment {
  /** 需要的 Python 版本（如 `3.13`）；null 表示交给 uv 自选。 */
  readonly pythonVersion: string | null;
  /** 透传给 `uv pip install` 的参数（顺序与原文保留）。 */
  readonly pipArgs: readonly string[];
  /** 任务声明的系统包（原生执行只告警跳过）。 */
  readonly aptPackages: readonly string[];
  /** 任务声明的构建期 shell 步骤（原生执行只告警跳过）。 */
  readonly shellCommands: readonly string[];
  /** 种子文件摆放规则；空数组表示「整个任务目录兜底拷贝」。 */
  readonly seeds: readonly TaskSeed[];
  /** 声明来源。 */
  readonly source: TaskEnvironmentSource;
  /** 读取期的非致命告警（损坏的 env.json、推断出的取值等）。 */
  readonly warnings: readonly string[];
}

/**
 * `env.json` 的解析结果。
 *
 * 字段为 `undefined` 表示「文件里没声明」，调用方据此回落到标准清单；
 * 空数组是**已声明**（如 `seeds: []` = 兜底拷贝），二者不可混同。
 * JSON 的 `null` 一律按「未声明」处理（显式写 `"python": null` 是表达「交 uv 自选」的自然写法）。
 */
export interface EnvFileSpec {
  /** `python` 字段。 */
  readonly pythonVersion: string | null | undefined;
  /** `pip` 字段。 */
  readonly pipArgs: readonly string[] | undefined;
  /** `apt` 字段。 */
  readonly aptPackages: readonly string[] | undefined;
  /** `shell` 字段。 */
  readonly shellCommands: readonly string[] | undefined;
  /** `seeds` 字段。 */
  readonly seeds: readonly TaskSeed[] | undefined;
  /** 解析期的非致命告警。 */
  readonly warnings: readonly string[];
}

/** 从标准清单推断出的字段（全部为确定值，另带 `found` 与告警）。 */
interface InferredFields {
  /** Python 版本。 */
  readonly pythonVersion: string | null;
  /** pip 参数。 */
  readonly pipArgs: readonly string[];
  /** 系统包。 */
  readonly aptPackages: readonly string[];
  /** 构建期 shell 步骤（标准清单里没有这一项，恒为空）。 */
  readonly shellCommands: readonly string[];
  /** 种子规则（标准清单里没有这一项，恒为空=兜底拷贝）。 */
  readonly seeds: readonly TaskSeed[];
  /** 是否真的推出了东西（决定 `source` 报 `manifests` 还是 `none`）。 */
  readonly found: boolean;
  /** 推断过程说明。 */
  readonly warnings: readonly string[];
}

/** 任务环境描述读取器（纯静态工具类，无可变状态）。 */
export class TaskEnvironmentReader {
  /** 显式环境声明的文件名。 */
  public static readonly ENV_FILE = 'env.json';

  /** 标准依赖清单（`uv pip install -r`）。 */
  public static readonly REQUIREMENTS_FILE = 'requirements.txt';

  /** 标准 Python 版本文件（`uv venv --python` 读得懂）。 */
  public static readonly PYTHON_VERSION_FILE = '.python-version';

  /** 标准系统包清单（Binder 约定）。 */
  private static readonly APT_FILES: readonly string[] = ['apt.txt', 'packages.txt'];

  /** 可安装为项目本体的清单（存在即按可编辑方式装任务项目）。 */
  private static readonly PROJECT_FILES: readonly string[] = ['pyproject.toml', 'setup.py'];

  /** `env.json` 允许的键（其余键一律告警忽略，避免拼错字段被静默吞掉）。 */
  private static readonly KNOWN_KEYS: readonly string[] = [
    'python',
    'pip',
    'apt',
    'shell',
    'seeds',
  ];

  private constructor() {}

  /**
   * 读取一个任务的环境描述。
   *
   * @param taskDir 任务目录。
   * @returns 环境描述（`env.json` 优先，未声明的字段回落标准清单；永不抛错）。
   */
  public static read(taskDir: string): TaskEnvironment {
    const declared = TaskEnvironmentReader.readEnvFile(taskDir);
    const inferred = TaskEnvironmentReader.infer(taskDir);
    return {
      pythonVersion: declared?.pythonVersion ?? inferred.pythonVersion,
      pipArgs: declared?.pipArgs ?? inferred.pipArgs,
      aptPackages: declared?.aptPackages ?? inferred.aptPackages,
      shellCommands: declared?.shellCommands ?? inferred.shellCommands,
      seeds: declared?.seeds ?? inferred.seeds,
      source: TaskEnvironmentReader.sourceOf(declared, inferred),
      warnings: [...(declared?.warnings ?? []), ...inferred.warnings],
    };
  }

  /**
   * 解析 `env.json` 文本（纯函数，便于单测）。
   *
   * 容错原则：**单个字段写错不该让整题环境失败**——坏字段忽略并告警，其余字段照常生效；
   * 整个文件不是合法 JSON 时全部字段置「未声明」，由标准清单接手。
   *
   * @param raw 文件原文。
   * @returns 解析结果（含告警）。
   */
  public static parse(raw: string): EnvFileSpec {
    const empty: EnvFileSpec = {
      pythonVersion: undefined,
      pipArgs: undefined,
      aptPackages: undefined,
      shellCommands: undefined,
      seeds: undefined,
      warnings: [],
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        ...empty,
        warnings: [
          `${TaskEnvironmentReader.ENV_FILE} 不是合法 JSON，已忽略并按标准清单回落：${TaskEnvironmentReader.message(error)}`,
        ],
      };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ...empty,
        warnings: [`${TaskEnvironmentReader.ENV_FILE} 顶层必须是对象，已忽略并按标准清单回落`],
      };
    }
    const record = parsed as Record<string, unknown>;
    const warnings: string[] = [];
    const spec: EnvFileSpec = {
      pythonVersion: TaskEnvironmentReader.versionOf(record['python'], warnings),
      pipArgs: TaskEnvironmentReader.stringListOf(record['pip'], 'pip', warnings),
      aptPackages: TaskEnvironmentReader.stringListOf(record['apt'], 'apt', warnings),
      shellCommands: TaskEnvironmentReader.stringListOf(record['shell'], 'shell', warnings),
      seeds: TaskEnvironmentReader.seedsOf(record['seeds'], warnings),
      warnings,
    };
    TaskEnvironmentReader.warnUnknownKeys(record, warnings);
    return spec;
  }

  /**
   * 读取 `env.json`。
   *
   * @param taskDir 任务目录。
   * @returns 解析结果；文件不存在时 null。
   */
  private static readEnvFile(taskDir: string): EnvFileSpec | null {
    const path = join(taskDir, TaskEnvironmentReader.ENV_FILE);
    if (!existsSync(path)) {
      return null;
    }
    return TaskEnvironmentReader.parse(readFileSync(path, 'utf8'));
  }

  /**
   * 判定声明来源（按「实际提供了取值的那个来源」记，不按文件是否存在记）。
   *
   * @param declared `env.json` 解析结果（不存在为 null）。
   * @param inferred 标准清单推断结果。
   * @returns 来源标记。
   */
  private static sourceOf(
    declared: EnvFileSpec | null,
    inferred: InferredFields,
  ): TaskEnvironmentSource {
    if (declared !== null && TaskEnvironmentReader.hasDeclaredField(declared)) {
      return TaskEnvironmentReader.ENV_FILE;
    }
    return inferred.found ? 'manifests' : 'none';
  }

  /**
   * `env.json` 是否至少声明了一个字段。
   *
   * @param spec 解析结果。
   * @returns 有任一字段被声明则为 true。
   */
  private static hasDeclaredField(spec: EnvFileSpec): boolean {
    return (
      spec.pythonVersion !== undefined ||
      spec.pipArgs !== undefined ||
      spec.aptPackages !== undefined ||
      spec.shellCommands !== undefined ||
      spec.seeds !== undefined
    );
  }

  /**
   * 按标准清单推断环境（只用容器无关、生态自带的清单）。
   *
   * @param taskDir 任务目录。
   * @returns 推断结果（含逐条说明）。
   */
  private static infer(taskDir: string): InferredFields {
    const warnings: string[] = [];
    const pythonVersion = TaskEnvironmentReader.inferPythonVersion(taskDir, warnings);
    const pipArgs = TaskEnvironmentReader.inferPipArgs(taskDir, warnings);
    const aptPackages = TaskEnvironmentReader.listFile(taskDir, TaskEnvironmentReader.APT_FILES);
    return {
      pythonVersion,
      pipArgs,
      aptPackages,
      shellCommands: [],
      seeds: [],
      found: pythonVersion !== null || pipArgs.length > 0 || aptPackages.length > 0,
      warnings,
    };
  }

  /**
   * 推断 Python 版本：`.python-version` 优先，其次 `pyproject.toml` 的 `requires-python`。
   *
   * @param taskDir 任务目录。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 版本串；推断不出为 null。
   */
  private static inferPythonVersion(taskDir: string, warnings: string[]): string | null {
    const versionFile = join(taskDir, TaskEnvironmentReader.PYTHON_VERSION_FILE);
    if (existsSync(versionFile)) {
      const first = readFileSync(versionFile, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== '' && !line.startsWith('#'));
      if (first !== undefined) {
        const version = TaskEnvironmentReader.normalizeVersion(first);
        if (version !== null) {
          warnings.push(
            `未声明 python，按 ${TaskEnvironmentReader.PYTHON_VERSION_FILE} 取 ${version}`,
          );
          return version;
        }
      }
    }
    const projectFile = join(taskDir, 'pyproject.toml');
    if (existsSync(projectFile)) {
      const match = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(
        readFileSync(projectFile, 'utf8'),
      );
      const version = match === null ? null : TaskEnvironmentReader.normalizeVersion(match[1]!);
      if (version !== null) {
        warnings.push(`未声明 python，按 pyproject.toml 的 requires-python 取 ${version}`);
        return version;
      }
    }
    return null;
  }

  /**
   * 推断 pip 参数：`requirements.txt` 走 `-r`，任务自带项目（pyproject/setup.py）按可编辑装。
   *
   * @param taskDir 任务目录。
   * @param warnings 告警收集数组（就地追加）。
   * @returns `uv pip install` 的参数。
   */
  private static inferPipArgs(taskDir: string, warnings: string[]): readonly string[] {
    const args: string[] = [];
    if (existsSync(join(taskDir, TaskEnvironmentReader.REQUIREMENTS_FILE))) {
      args.push('-r', TaskEnvironmentReader.REQUIREMENTS_FILE);
      warnings.push(
        `未声明 pip，按 ${TaskEnvironmentReader.REQUIREMENTS_FILE} 安装（uv pip install -r ${TaskEnvironmentReader.REQUIREMENTS_FILE}）`,
      );
    }
    const project = TaskEnvironmentReader.PROJECT_FILES.find((name) =>
      existsSync(join(taskDir, name)),
    );
    if (project !== undefined) {
      args.push('-e', '.');
      warnings.push(
        `未声明 pip，按 ${project} 存在把任务项目以可编辑方式安装（uv pip install -e .）`,
      );
    }
    return args;
  }

  /**
   * 读一个「每行一项」的清单文件（取第一个存在的候选）。
   *
   * @param taskDir 任务目录。
   * @param names 候选文件名（按优先级）。
   * @returns 条目列表（去注释、去空、按空白切分）；文件不存在为空数组。
   */
  private static listFile(taskDir: string, names: readonly string[]): readonly string[] {
    const name = names.find((candidate) => existsSync(join(taskDir, candidate)));
    if (name === undefined) {
      return [];
    }
    return readFileSync(join(taskDir, name), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .flatMap((line) => line.split(/\s+/));
  }

  /**
   * 归一 `python` 字段（数字写法也接受：`3.13` 与 `"3.13"` 等价）。
   *
   * @param value 原始取值。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 版本串；未声明为 undefined，写法非法为 null。
   */
  private static versionOf(value: unknown, warnings: string[]): string | null | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const text = typeof value === 'number' ? String(value) : value;
    const version = TaskEnvironmentReader.normalizeVersion(text);
    if (version === null) {
      warnings.push(
        `${TaskEnvironmentReader.ENV_FILE} 的 python 字段无法识别（已忽略）：${String(value)}`,
      );
    }
    return version;
  }

  /**
   * 归一字符串列表字段。
   *
   * @param value 原始取值。
   * @param key 字段名（用于告警）。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 列表；未声明为 undefined。
   */
  private static stringListOf(
    value: unknown,
    key: string,
    warnings: string[],
  ): readonly string[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      warnings.push(`${TaskEnvironmentReader.ENV_FILE} 的 ${key} 字段必须是数组（已忽略）`);
      return undefined;
    }
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') {
        out.push(item.trim());
      } else {
        warnings.push(
          `${TaskEnvironmentReader.ENV_FILE} 的 ${key} 字段含非字符串/空项（已忽略该条）`,
        );
      }
    }
    return out;
  }

  /**
   * 归一 `seeds` 字段（字符串简写 `"a/b.csv"` 等价于 `{ from: "a/b.csv", to: "." }`）。
   *
   * @param value 原始取值。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 规则列表；未声明为 undefined。
   */
  private static seedsOf(value: unknown, warnings: string[]): readonly TaskSeed[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      warnings.push(`${TaskEnvironmentReader.ENV_FILE} 的 seeds 字段必须是数组（已忽略）`);
      return undefined;
    }
    const out: TaskSeed[] = [];
    for (const item of value) {
      const seed = TaskEnvironmentReader.seedOf(item, warnings);
      if (seed !== null) {
        out.push(seed);
      }
    }
    return out;
  }

  /**
   * 归一单条种子规则。
   *
   * @param item 原始条目。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 规则；形状不认识为 null。
   */
  private static seedOf(item: unknown, warnings: string[]): TaskSeed | null {
    if (typeof item === 'string') {
      const from = item.trim();
      return from === '' ? null : { from, to: '.' };
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      warnings.push(`${TaskEnvironmentReader.ENV_FILE} 的 seeds 含无法识别的条目（已忽略）`);
      return null;
    }
    const record = item as Record<string, unknown>;
    const from = record['from'];
    if (typeof from !== 'string' || from.trim() === '') {
      warnings.push(`${TaskEnvironmentReader.ENV_FILE} 的 seeds 条目缺少 from（已忽略）`);
      return null;
    }
    const to = record['to'];
    return { from: from.trim(), to: typeof to === 'string' && to.trim() !== '' ? to.trim() : '.' };
  }

  /**
   * 对未知键告警（拼错 `pip` 为 `pips` 这类错误若静默，会表现成「依赖没装上」的假环境失败）。
   *
   * @param record 解析出的对象。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 无返回值。
   */
  private static warnUnknownKeys(record: Record<string, unknown>, warnings: string[]): void {
    for (const key of Object.keys(record)) {
      if (!TaskEnvironmentReader.KNOWN_KEYS.includes(key)) {
        warnings.push(`${TaskEnvironmentReader.ENV_FILE} 出现未知字段 ${key}（已忽略）`);
      }
    }
  }

  /**
   * 归一版本串（去掉 `v` / `python-` 前缀与 `>=` 这类比较符，保留主次版本）。
   *
   * @param value 原始取值。
   * @returns `3.13` 形态；不是版本串为 null。
   */
  private static normalizeVersion(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const cleaned = value
      .trim()
      .replace(/^(?:python[-_ ]?|v)/i, '')
      .replace(/^[<>=~^!\s]+/, '');
    const match = /^(\d+)(?:\.(\d+))?/.exec(cleaned);
    if (match === null) {
      return null;
    }
    return match[2] === undefined ? match[1]! : `${match[1]}.${match[2]}`;
  }

  /**
   * 把异常收敛成一句可读原因。
   *
   * @param error 异常。
   * @returns 原因文本。
   */
  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
