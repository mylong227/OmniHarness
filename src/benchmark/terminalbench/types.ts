/**
 * Terminal-Bench 评测适配器的共享类型（B2）。
 *
 * ## 任务契约（对齐上游 2026-06 版真实 schema）
 *
 * 上游每个任务是一个目录，含：
 * - `task.yaml` —— `instruction` / `author_name` / `difficulty` / `category`(单数) /
 *   `tags[]` / `parser_name` / `max_agent_timeout_sec` / `max_test_timeout_sec`；
 * - `env.json` —— **本适配器的环境声明**（Python 版本 / pip 参数 / 系统包 / 构建期步骤 /
 *   种子文件落点）；缺失时按标准清单推断（见 {@link TaskEnvironmentReader}）；
 * - `run-tests.sh` —— 判分脚手架，末尾固定是 `uv run pytest $TEST_DIR/test_outputs.py -rA`，
 *   其依赖由同一文件里的 `uv pip install …` 行声明；
 * - `tests/test_outputs.py` —— 判分断言本体；
 * - `solution.sh` / `solution.yaml` —— 参考解（评测时不执行）。
 *
 * ## 执行模型（2026-09-19 重写：**原生执行**，不依赖任何容器运行时）
 *
 * 基准的语义其实是三件事：**一次性、可回收、环境自足**的执行上下文，
 * 且判分脚本在「工作目录 = `/app`、`$TEST_DIR` = 判分脚本目录」的环境里跑。
 * 本适配器把这三件事逐条原生复现，而不是去模拟某个运行时：
 *
 * ① **一次性 / 可回收**：{@link ExecutionBackend.prepare} 为每个任务开一个独立目录树，
 *    {@link ExecutionBackend.teardown} 整棵删除。源任务目录在整轮评测里**只读**——
 *    这条不变量保证同批任务可重复跑、结果可第三方复算。
 * ② **环境自足**：Python 用户态由 `uv` 现场重建（{@link PythonEnvironmentProvisioner}），
 *    任务依赖与版本取 `env.json`（缺失时取 `.python-version` / `requirements.txt` /
 *    `pyproject.toml` / `apt.txt` 这些**容器无关**的标准清单）与 `run-tests.sh` 的
 *    `uv pip install` 声明（{@link TaskEnvironmentReader} / {@link JudgeScriptReader}），
 *    不猜、不硬编码，也不需要任何构建配方解析器。
 * ③ **容器内绝对路径**：`/app` 由 {@link AppRootMapper} 用操作系统的**真实目录/链接**
 *    指到本任务的应用目录——这正是挂载在做的事，只是不需要挂载。
 *
 * 环境无法满足时（缺 `uv`、无法占据 `/app`、`parser_name` 非 `pytest`），
 * 一律记 `envError` 并附**可执行的原因**，绝不静默算成「模型没做出来」。
 */
import type { TaskEnvironment } from './taskEnvironmentReader.js';

/** 单条命令的执行结果。 */
export interface CommandOutcome {
  /** 进程退出码（0 = 成功）。 */
  readonly exitCode: number;
  /** 标准输出（已按上限截断）。 */
  readonly stdout: string;
  /** 标准错误（已按上限截断）。 */
  readonly stderr: string;
  /** 是否因超时被终止。 */
  readonly timedOut: boolean;
}

/** 解析自 task.yaml 的单任务元信息。 */
export interface TerminalBenchTask {
  /** 任务名（**目录名**；上游 task.yaml 不再声明 name）。 */
  readonly name: string;
  /** 交给被评测 Agent 的指令正文。 */
  readonly instruction: string;
  /** 作者名。 */
  readonly authorName: string;
  /** 难度档位（easy/medium/hard）。 */
  readonly difficulty: string;
  /** 主分类（上游为单数字段 `category`）。 */
  readonly category: string;
  /** 标签列表（上游 `tags`）。 */
  readonly tags: readonly string[];
  /** 判分器名（上游 `parser_name`，本适配器仅支持 `pytest`）。 */
  readonly parserName: string;
  /** Agent 侧超时（秒，上游 `max_agent_timeout_sec`）。 */
  readonly maxAgentTimeoutSec: number;
  /** 判分侧超时（秒，上游 `max_test_timeout_sec`）。 */
  readonly maxTestTimeoutSec: number;
  /** 任务目录绝对路径（**只读源目录**；执行发生在后端给出的一次性目录里）。 */
  readonly taskDir: string;
  /** 判分脚手架 run-tests.sh 绝对路径（只读参考；原生判分直接跑 pytest，不跑其中的装包步骤）。 */
  readonly testScript: string;
  /** 判分断言目录（等价容器里的 `$TEST_DIR`）。 */
  readonly testsDir: string;
  /** 参考解路径（`solution.sh` / `solution.yaml`）；缺失为 null。 */
  readonly solutionScript: string | null;
  /** 环境声明（容器无关：解释器版本 / pip 参数 / 系统包 / 构建期步骤 / 种子落点）。 */
  readonly environment: TaskEnvironment;
  /** 判分所需的 Python 包（从 run-tests.sh 的 `uv pip install` 行解析）。 */
  readonly judgePackages: readonly string[];
}

/** 一次任务准备完后端交给判分器/求解器的一切。 */
export interface PreparedTask {
  /** 应用目录绝对路径（**等价容器里的 `/app`**，也是子进程的工作目录）。 */
  readonly appDir: string;
  /** 判分脚本目录绝对路径（**等价 `$TEST_DIR`**）。 */
  readonly testsDir: string;
  /** 任务所用的 Python 解释器绝对路径；未装出环境时为 null。 */
  readonly pythonPath: string | null;
  /** 需要注入每个子进程的环境变量（如 `VIRTUAL_ENV` / `PATH` / `TEST_DIR`）。 */
  readonly env: Readonly<Record<string, string>>;
  /** 准备阶段产生的**非致命**告警（如跳过的 `apt` 命令）；供报告如实展示。 */
  readonly warnings: readonly string[];
  /**
   * 本环境里可用的 POSIX shell 绝对路径（没有则为 `null`）。
   *
   * 为什么放进契约：Agent 与参考解需要它，而「哪个 bash」这件事只有后端知道
   * （PATH 扫描 / `OMNI_BASH` / 平台已知位置）。让调用方各自猜，就会出现
   * 「同一个环境里参考解用一个 bash、Agent 用另一个」的诡异不一致。
   */
  readonly bashPath?: string | null | undefined;
}

/**
 * 执行后端：一次性工作目录 + argv 命令执行。
 *
 * 契约要点（写进接口而不是注释，避免实现方各写各的）：
 * - `prepare` 必须返回**与源任务目录分离**的一次性上下文；源任务目录整轮不得被改动。
 * - `runCommand` 必须**有界**：超时必须终止子进程并返回，绝不无限等待。
 * - `teardown` 幂等；回收失败不得让整轮评测失败（只记警告）。
 */
export interface ExecutionBackend {
  /** 后端名（用于报告区分与可观测，如 `native`）。 */
  readonly name: string;
  /**
   * 为一次任务准备一次性执行上下文。
   *
   * @param task 待执行任务（其 `taskDir` 为源目录，只读）。
   * @returns 应用目录 / 判分目录 / 解释器 / 注入环境。
   */
  prepare(task: TerminalBenchTask): Promise<PreparedTask>;
  /**
   * 在给定工作目录执行一条 argv 命令（不经 shell 文本解释，杜绝注入）。
   *
   * @param cmd 命令与参数（argv 数组）。
   * @param workdir 工作目录（通常是 `prepared.appDir`）。
   * @param extraEnv 额外注入的环境变量（叠加在 `prepared.env` 之上）。
   * @param timeoutMs 覆盖默认超时（毫秒）；未提供时用后端默认值。
   * @returns 退出码、输出与超时标记。
   */
  runCommand(
    cmd: readonly string[],
    workdir: string,
    extraEnv?: Readonly<Record<string, string>>,
    timeoutMs?: number,
  ): Promise<CommandOutcome>;
  /**
   * 回收一次性上下文（幂等；失败只记警告）。
   *
   * @param prepared `prepare` 的返回值。
   * @returns 无返回值。
   */
  teardown(prepared: PreparedTask): Promise<void>;
}

/** 判分结果。 */
export interface JudgeOutcome {
  /** 是否通过。 */
  readonly passed: boolean;
  /** 判分进程退出码（envError 时为 -1）。 */
  readonly exitCode: number;
  /** 判分输出摘要（尾部，供报告与人审阅）。 */
  readonly output: string;
  /** 是否超时。 */
  readonly timedOut: boolean;
  /** 非 null 表示判分**未真正执行**（环境原因），须从能力分分母剔除。 */
  readonly envError: string | null;
}

/** 判分器：只认「给定任务 + 已准备好的上下文 → 通过与否」。 */
export interface TaskJudge {
  /** 判分器名（写入报告，如 `pytest`）。 */
  readonly name: string;
  /**
   * 执行判分。
   *
   * @param task 任务元信息（提供 `maxTestTimeoutSec` 等）。
   * @param prepared 后端准备好的上下文。
   * @returns 判分结果（环境原因一律走 `envError`，不抛错）。
   */
  judge(task: TerminalBenchTask, prepared: PreparedTask): Promise<JudgeOutcome>;
}

/**
 * 执行一条 argv 命令的接缝。
 *
 * 为什么要单独抽出这个类型：环境制备器与语料抓取器都需要「跑一条命令」，
 * 但它们都不应该自己持有进程能力（否则没法在单测里注入假执行、也没法统一超时与截断）。
 * 后端把自己作为该接缝传下去，于是「谁执行的」永远只有一个答案。
 */
export type CommandRunner = (
  cmd: readonly string[],
  workdir: string,
  extraEnv: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<CommandOutcome>;

/** 预算约束：限制 Solver 的工具调用次数与总时长，用于与 grep 基线同预算对照。 */
export interface BenchmarkBudget {
  /** 允许的最大工具调用次数（含 grep / Agent 步骤）。 */
  readonly maxToolCalls: number;
  /** 单任务最大时长（毫秒）。 */
  readonly maxDurationMs: number;
}

/** Solver 一次求解的产出。 */
export interface SolverOutcome {
  /** 产出的「答案」文本（供人/日志审阅）。 */
  readonly answer: string;
  /** 实际消耗的工具调用次数。 */
  readonly budgetUsed: number;
}

/**
 * 单次求解的上下文。
 *
 * 为什么把 `prepared` 放进契约而不是让 Solver 自己算：命令必须在 `prepare()` 给出的
 * 一次性目录里执行，**源任务目录只读**；解释器与环境变量也由后端统一给出，
 * 否则「Agent 用什么 python」与「判分用什么 python」会各说各话。
 */
export interface SolverInput {
  /** 任务元信息。 */
  readonly task: TerminalBenchTask;
  /** 执行后端（命令都经它执行，不直连宿主）。 */
  readonly backend: ExecutionBackend;
  /** 预算约束。 */
  readonly budget: BenchmarkBudget;
  /** 本次任务的一次性执行上下文（`backend.prepare` 的返回值）。 */
  readonly prepared: PreparedTask;
}

/** Solver 抽象：OmniHarness 驱动与 grep 基线都实现此接口，接受同一预算。 */
export interface Solver {
  /** Solver 名称（用于报告区分）。 */
  readonly name: string;
  /**
   * 在预算内求解单任务。
   *
   * @param input 求解上下文（任务 / 后端 / 预算 / 一次性上下文）。
   * @returns 答案与预算消耗。
   */
  solve(input: SolverInput): Promise<SolverOutcome>;
}

/** 单任务运行结果（写入报告）。 */
export interface TaskResult {
  /** 任务名。 */
  readonly task: string;
  /** 使用的 Solver。 */
  readonly solver: string;
  /** 是否通过（判分器退出码 0）。 */
  readonly passed: boolean;
  /**
   * 是否属于**环境失败**（后端不可用 / 判分脚本无法启动 / 超时），区别于「模型没做出来」。
   *
   * 为什么必须分开：环境噪声若计成能力分，会让「换台机器重跑」得到不同结论——
   * 这正是本仓 SWE-bench 侧已用 `envError` 解决过的同一类问题，此处沿用同一口径。
   */
  readonly envError: boolean;
  /** 消耗的工具调用次数。 */
  readonly budgetUsed: number;
  /** 耗时（毫秒）。 */
  readonly durationMs: number;
  /** 失败原因；通过时为 null。 */
  readonly error: string | null;
}

/** 整轮套件报告。 */
export interface SuiteReport {
  /** Solver 名称。 */
  readonly solver: string;
  /** 执行后端名（便于报告自述「在什么上跑出来的」）。 */
  readonly backend: string;
  /** 判分器名。 */
  readonly judge: string;
  /** 运行平台（`<platform>/<arch>`，跨平台结果不可直接互比）。 */
  readonly platform: string;
  /** 任务总数。 */
  readonly total: number;
  /** 通过数。 */
  readonly passed: number;
  /** 通过率（0–1；**含**环境失败，故跨机器不可比）。 */
  readonly passRate: number;
  /** 环境失败数（被判定为环境原因、不应计入能力分的任务数）。 */
  readonly envErrors: number;
  /**
   * 有效解题率 = `passed / (total - envErrors)`。
   * 全部任务都环境失败时为 0（而不是 NaN/Infinity）。
   */
  readonly effectivePassRate: number;
  /** 环境失败原因的直方图（原因 → 任务数），让「为什么没跑成」一眼可见。 */
  readonly envErrorReasons: Readonly<Record<string, number>>;
  /** 逐任务结果。 */
  readonly results: readonly TaskResult[];
}

/** 注入给 OmniSolver 的真实 Agent 运行时接缝签名。 */
export interface AgentRunnerInput {
  /** 待求解任务。 */
  readonly task: TerminalBenchTask;
  /** 执行后端（供 Agent 执行命令）。 */
  readonly backend: ExecutionBackend;
  /** 预算约束。 */
  readonly budget: BenchmarkBudget;
  /** 本次任务的一次性执行上下文（Agent 的落点，不是源任务目录）。 */
  readonly prepared: PreparedTask;
}

/** Agent 运行时产出。 */
export interface AgentRunnerOutcome {
  /** 产出答案。 */
  readonly answer: string;
  /** 消耗的工具调用次数。 */
  readonly budgetUsed: number;
}

/** 真实 Agent 运行时接缝：未注入时 fail-closed。 */
export type AgentRunner = (input: AgentRunnerInput) => Promise<AgentRunnerOutcome>;
