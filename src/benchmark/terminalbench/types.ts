/**
 * Terminal-Bench 评测适配器的共享类型（B2）。
 *
 * 设计：Terminal-Bench 任务以「目录」形式存在（task.yaml + solution.sh + run-tests.sh），
 * 每任务可自带隔离环境（docker）。本适配器把「任务解析 / 容器后端 / Solver / 计分」四者解耦，
 * 使 OmniHarness 与 grep 基线能在**同一预算**下公平对照。
 */

/** 单条命令的执行结果。 */
export interface CommandOutcome {
  /** 进程退出码（0 = 成功）。 */
  readonly exitCode: number;
  /** 标准输出。 */
  readonly stdout: string;
  /** 标准错误。 */
  readonly stderr: string;
}

/** 容器后端抽象：真实隔离（docker）与本地开发（非隔离）都实现此接口。 */
export interface ContainerBackend {
  /** 后端种类；`local` 仅用于适配器开发与单测，不提供隔离。 */
  readonly kind: 'docker' | 'local';
  /** 在给定工作目录执行一条 argv 命令，返回退出码与输出。 */
  runCommand(cmd: readonly string[], workdir: string): Promise<CommandOutcome>;
}

/** 预算约束：限制 Solver 的工具调用次数与总时长，用于与 grep 基线同预算对照。 */
export interface BenchmarkBudget {
  /** 允许的最大工具调用次数（含 grep / Agent 步骤）。 */
  readonly maxToolCalls: number;
  /** 单任务最大时长（毫秒）。 */
  readonly maxDurationMs: number;
}

/** 解析自 task.yaml 的单任务元信息。 */
export interface TerminalBenchTask {
  /** 任务名（来自 task.yaml 的 name）。 */
  readonly name: string;
  /** 作者。 */
  readonly author: string;
  /** 难度档位（easy/medium/hard 等）。 */
  readonly difficulty: string;
  /** 分类标签列表。 */
  readonly categories: readonly string[];
  /** 任务期望的 docker 镜像；本地后端忽略此字段。 */
  readonly dockerImage: string | null;
  /** 任务目录绝对路径。 */
  readonly taskDir: string;
  /** solution.sh 绝对路径（参考解，评测时一般不执行）。 */
  readonly solutionScript: string;
  /** run-tests.sh 绝对路径（判分脚本）。 */
  readonly testScript: string;
  /** setup.sh 绝对路径（可选）。 */
  readonly setupScript: string | null;
}

/** Solver 一次求解的产出。 */
export interface SolverOutcome {
  /** 产出的「答案」文本（供人/日志审阅）。 */
  readonly answer: string;
  /** 实际消耗的工具调用次数。 */
  readonly budgetUsed: number;
}

/** Solver 抽象：OmniHarness 驱动与 grep 基线都实现此接口，接受同一预算。 */
export interface Solver {
  /** Solver 名称（用于报告区分）。 */
  readonly name: string;
  /** 在预算内求解单任务。 */
  solve(
    task: TerminalBenchTask,
    backend: ContainerBackend,
    budget: BenchmarkBudget,
  ): Promise<SolverOutcome>;
}

/** 单任务运行结果（写入报告）。 */
export interface TaskResult {
  /** 任务名。 */
  readonly task: string;
  /** 使用的 Solver。 */
  readonly solver: string;
  /** 是否通过（run-tests.sh 退出码 0）。 */
  readonly passed: boolean;
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
  /** 任务总数。 */
  readonly total: number;
  /** 通过数。 */
  readonly passed: number;
  /** 通过率（0–1）。 */
  readonly passRate: number;
  /** 逐任务结果。 */
  readonly results: readonly TaskResult[];
}

/** 注入给 OmniSolver 的真实 Agent 运行时接缝签名。 */
export interface AgentRunnerInput {
  /** 待求解任务。 */
  readonly task: TerminalBenchTask;
  /** 容器后端（供 Agent 执行命令）。 */
  readonly backend: ContainerBackend;
  /** 预算约束。 */
  readonly budget: BenchmarkBudget;
}

/** Agent 运行时产出。 */
export interface AgentRunnerOutcome {
  /** 产出答案。 */
  readonly answer: string;
  /** 消耗的工具调用次数。 */
  readonly budgetUsed: number;
}

/** 真实 Agent 运行时接缝：沙箱无 Agent 运行时，默认 fail-closed。 */
export type AgentRunner = (input: AgentRunnerInput) => Promise<AgentRunnerOutcome>;
