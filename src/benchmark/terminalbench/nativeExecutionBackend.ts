/**
 * 原生执行后端：把一个 Terminal-Bench 任务在**本机**跑起来，不需要任何容器运行时。
 *
 * ## 它复现的三件事
 *
 * `prepare()` 一次性做完下面全部，返回后任务环境即处于「判分脚本可以直接跑」的状态：
 *
 * 1. **一次性目录树**：`<workRoot>/<task>-<rand>/{app,tests}`。
 *    `app` 是判分脚本视角的 `/app`，`tests` 是它视角的 `$TEST_DIR`——上游把两者分开放，
 *    这里也分开（判分脚本因此**不会**把测试文件当成任务产物看到）。
 * 2. **种子文件按声明落位**：`env.json` 的 `seeds` 说 `task-deps/data.csv` 要落到应用根，
 *    就落到 `/app/data.csv`，而不是 `/app/task-deps/data.csv`。按声明落位，
 *    而不是「整棵目录拷过去碰运气」；未声明 `seeds` 时才整目录兜底拷贝。
 * 3. **环境自足**：`uv` 现场建解释器环境并装齐任务依赖与判分依赖
 *    （见 {@link PythonEnvironmentProvisioner}），再把判分脚本写死的绝对路径 `/app`
 *    用操作系统自己的链接原语指到 `app`（见 {@link AppRootMapper}）。
 *
 * ## 环境不满足时的行为
 *
 * 一律**如实报错**而不是伪装成功：{@link unavailableReason} 在整轮开始前给出机器级原因
 * （缺 `uv`、`/app` 占不住），运行器据此把全部任务记成环境失败；
 * 单题准备失败则抛出带原因的错误，由运行器记单题环境失败。
 * 任务声明了原生执行给不出的东西（系统包、构建期 shell 步骤）时，
 * 逐条写进 `warnings` 而不是假装装上了。
 * 「模型没做出来」与「机器没准备好」绝不混为一谈。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, parse as parsePath } from 'node:path';
import type { CommandOutcome, ExecutionBackend, PreparedTask, TerminalBenchTask } from './types.js';
import type { TaskEnvironment } from './taskEnvironmentReader.js';
import { TaskSeeder } from './taskSeeder.js';
import { AppRootMapper } from './appRootMapper.js';
import type { AppRootClaim } from './appRootMapper.js';
import { BashAppRootMapper } from './bashAppRootMapper.js';
import type { BashAppRootClaim } from './bashAppRootMapper.js';
import { PythonEnvironmentProvisioner } from './pythonEnvironmentProvisioner.js';
import { SafeRemoveTree } from '../../util/safeRemoveTree.js';
import { log } from '../../util/logger.js';

/** 后端可选项（全部可注入，便于测试与跨平台部署）。 */
export interface NativeExecutionBackendOptions {
  /** 一次性工作目录的父目录（缺省 `<cwd>/.omniharness/tbench-work`）。 */
  readonly workRoot?: string | undefined;
  /** 单条命令超时（毫秒，缺省 300000 = 5 分钟）。 */
  readonly commandTimeoutMs?: number | undefined;
  /** 单路输出保留上限（字节，缺省 1 MiB）。 */
  readonly maxOutputBytes?: number | undefined;
  /** 是否建立容器内 `/app` 映射（缺省 true）。关闭后依赖 `/app` 绝对路径的任务会失败。 */
  readonly appMap?: boolean | undefined;
  /** 环境制备超时（毫秒，缺省 10 分钟）。 */
  readonly provisionTimeoutMs?: number | undefined;
}

/** 后端运行期状态（按 appDir 索引，供 teardown 归还）。 */
interface BackendSession {
  /** 一次性目录树的根（`app` 与 `tests` 的父目录）。 */
  readonly parent: string;
  /** 操作系统命名空间 `/app` 的映射凭据（未建立时为 null）。 */
  readonly claim: AppRootClaim | null;
  /** bash 命名空间 `/app` 的映射凭据（未建立时为 null）。 */
  readonly bashClaim: BashAppRootClaim | null;
}

/** 应用根目录名（`<parent>/app`）。 */
const APP_DIR_NAME = 'app';

/** 判分脚本目录名（`<parent>/tests`）。 */
const TESTS_DIR_NAME = 'tests';

/** 原生执行后端。 */
export class NativeExecutionBackend implements ExecutionBackend {
  /** 后端名（写入报告）。 */
  public readonly name = 'native';

  /** 默认单条命令超时（毫秒）。 */
  public static readonly DEFAULT_TIMEOUT_MS = 300_000;

  /** 默认单路输出上限（字节）：1 MiB。 */
  public static readonly DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

  /** 一次性工作目录的父目录。 */
  private readonly workRoot: string;
  /** 单条命令超时（毫秒）。 */
  private readonly commandTimeoutMs: number;
  /** 单路输出上限（字节）。 */
  private readonly maxOutputBytes: number;
  /** 应用根映射器。 */
  private readonly appRootMapper: AppRootMapper;
  /** bash 命名空间应用根映射器。 */
  private readonly bashMapper: BashAppRootMapper;
  /** Python 环境制备器。 */
  private readonly provisioner: PythonEnvironmentProvisioner;
  /** 运行期状态（teardown 用）。 */
  private readonly sessions = new Map<string, BackendSession>();

  /**
   * @param options 可选项（工作根 / 超时 / 输出上限 / 是否映射 `/app`）。
   */
  public constructor(options: NativeExecutionBackendOptions = {}) {
    this.workRoot = options.workRoot ?? join(process.cwd(), '.omniharness', 'tbench-work');
    this.commandTimeoutMs = NativeExecutionBackend.clamp(
      options.commandTimeoutMs,
      NativeExecutionBackend.DEFAULT_TIMEOUT_MS,
    );
    this.maxOutputBytes = NativeExecutionBackend.clamp(
      options.maxOutputBytes,
      NativeExecutionBackend.DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.appRootMapper = new AppRootMapper(options.appMap ?? true);
    this.bashMapper = new BashAppRootMapper((cmd, workdir, extraEnv, timeoutMs) =>
      this.runCommand(cmd, workdir, extraEnv, timeoutMs),
    );
    this.provisioner = new PythonEnvironmentProvisioner(
      options.provisionTimeoutMs ?? PythonEnvironmentProvisioner.DEFAULT_INSTALL_TIMEOUT_MS,
    );
  }

  /**
   * 准备一次性执行上下文（种子文件 → 解释器环境 → `/app` 映射）。
   *
   * @param task 任务元信息。
   * @returns 就绪的执行上下文。
   * @throws 当任务目录不存在、环境制备失败或 `/app` 映射失败时（清场后再抛，不留垃圾）。
   */
  public async prepare(task: TerminalBenchTask): Promise<PreparedTask> {
    if (!existsSync(task.taskDir)) {
      throw new Error(`任务目录不存在: ${task.taskDir}`);
    }
    mkdirSync(this.workRoot, { recursive: true });
    const parent = mkdtempSync(join(this.workRoot, `${NativeExecutionBackend.slug(task.name)}-`));
    const appDir = join(parent, APP_DIR_NAME);
    const testsDir = join(parent, TESTS_DIR_NAME);
    mkdirSync(appDir, { recursive: true });
    const warnings: string[] = [...NativeExecutionBackend.environmentWarnings(task.environment)];
    try {
      NativeExecutionBackend.seedAppDir(task, appDir, warnings);
      cpSync(task.testsDir, testsDir, { recursive: true, force: true });
    } catch (error) {
      NativeExecutionBackend.removeTree(parent);
      throw error;
    }
    const provisioned = await this.provisioner.provision(
      appDir,
      NativeExecutionBackend.packageList(task),
      task.environment.pythonVersion,
      (cmd, workdir, extraEnv, timeoutMs) => this.runCommand(cmd, workdir, extraEnv, timeoutMs),
    );
    if (provisioned.envError !== null) {
      NativeExecutionBackend.removeTree(parent);
      throw new Error(provisioned.envError);
    }
    const claim = this.appRootMapper.claim(appDir);
    if (claim === null) {
      const reason = this.appRootMapper.reason() ?? '/app 映射失败';
      NativeExecutionBackend.removeTree(parent);
      throw new Error(reason);
    }
    // bash 命名空间的 /app 是**另一个**路径（MSYS 根之下），参考解与 POSIX 路径命令靠它。
    // 建不上不算环境失败（判分走 Python 照样能判），只记告警——把便利缺失说成环境失败会掩盖真因。
    const bashClaim = await this.bashMapper.claim(appDir, parent);
    if (bashClaim === null) {
      warnings.push(`bash 命名空间 /app 未建立：${this.bashMapper.reason() ?? '未知原因'}`);
    }
    this.sessions.set(appDir, { parent, claim, bashClaim });
    return {
      appDir,
      testsDir,
      pythonPath: provisioned.pythonPath,
      env: provisioned.env,
      warnings: [...warnings, ...provisioned.warnings],
      bashPath: this.bashMapper.bashPath(),
    };
  }

  /**
   * 在一次性上下文里执行 argv 命令。
   *
   * @param cmd 命令与参数。
   * @param workdir 工作目录。
   * @param extraEnv 额外注入的环境变量。
   * @param timeoutMs 覆盖默认超时（毫秒）。
   * @returns 退出码、输出与超时标记（输出按上限截断）。
   */
  public runCommand(
    cmd: readonly string[],
    workdir: string,
    extraEnv: Readonly<Record<string, string>> = {},
    timeoutMs?: number,
  ): Promise<CommandOutcome> {
    const file = cmd[0];
    if (file === undefined || file.trim() === '') {
      return Promise.resolve({ exitCode: 127, stdout: '', stderr: '空命令', timedOut: false });
    }
    const limit =
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : this.commandTimeoutMs;
    return new Promise<CommandOutcome>((resolve) => {
      const child = spawn(file, cmd.slice(1), {
        cwd: workdir,
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, limit);
      const finish = (exitCode: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = NativeExecutionBackend.append(stdout, chunk, this.maxOutputBytes);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = NativeExecutionBackend.append(stderr, chunk, this.maxOutputBytes);
      });
      // spawn 失败（ENOENT/EACCES）必须收敛成退出码，否则 Promise 永不 settle（整轮挂死）。
      child.on('error', (error: Error) => {
        stderr = NativeExecutionBackend.append(
          stderr,
          Buffer.from(String(error.message)),
          this.maxOutputBytes,
        );
        finish(127);
      });
      child.on('close', (code: number | null) => finish(code ?? 1));
    });
  }

  /**
   * 回收一次性上下文（幂等、best-effort）。
   *
   * 顺序要紧：先摘 `/app` 链接再删目录树——反过来会让链接短暂指向不存在的目标。
   *
   * @param prepared `prepare` 的返回值。
   * @returns 无返回值（回收失败不抛错）。
   */
  public async teardown(prepared: PreparedTask): Promise<void> {
    const session = this.sessions.get(prepared.appDir);
    if (session === undefined) {
      return;
    }
    this.sessions.delete(prepared.appDir);
    session.bashClaim?.release();
    session.claim?.release();
    NativeExecutionBackend.removeTree(session.parent);
  }

  /**
   * 探测本后端在**本机**是否可用（运行器据此整轮判环境失败）。
   *
   * @returns 可用时为 null；不可用时为人类可读且可执行的原因。
   */
  public unavailableReason(): string | null {
    if (this.provisioner.locateUv() === null) {
      return '宿主未找到 uv（安装：https://astral.sh/uv ；或用 OMNI_UV 指定绝对路径）——原生执行需要它现场重建任务声明的 Python 环境';
    }
    return this.appRootMapper.reason();
  }

  /**
   * 是否要求串行执行。
   *
   * `/app` 是全机唯一名字，同一时刻只能有一个任务占据它——这与「一个任务一个 `/app`」
   * 在并发度上等价。运行器据此把并发压到 1，**不做假并行**（并发写同一个 `/app` 会互相毁证据）。
   *
   * @returns 映射启用时为 true。
   */
  public requiresSerialExecution(): boolean {
    return this.appRootMapper.isEnabled();
  }

  /**
   * 从任务里汇总要装的东西（判分依赖 ∪ 环境声明的 pip 参数，恒含 pytest）。
   *
   * @param task 任务元信息。
   * @returns 去重后的 `uv pip install` 参数（含 `-e`/`-r` 这类旗标，顺序按环境声明）。
   */
  public static packageList(task: TerminalBenchTask): readonly string[] {
    const packages: string[] = [];
    for (const name of task.judgePackages) {
      if (!packages.includes(name)) {
        packages.push(name);
      }
    }
    for (const arg of task.environment.pipArgs) {
      if (!packages.includes(arg)) {
        packages.push(arg);
      }
    }
    if (!packages.some((p) => /^pytest(?:[=<>!]|$)/.test(p))) {
      packages.push('pytest');
    }
    return packages;
  }

  /**
   * 收集环境层面的告警（原生执行给不出的东西一律如实上报，不假装成功）。
   *
   * @param environment 任务环境声明。
   * @returns 告警列表（读取期告警 + 本次无法满足的声明）。
   */
  public static environmentWarnings(environment: TaskEnvironment): readonly string[] {
    const warnings: string[] = [...environment.warnings];
    if (environment.source === 'manifests') {
      warnings.push(
        '任务未提供 env.json，环境按标准清单（.python-version / requirements.txt / pyproject.toml / apt.txt）推断',
      );
    }
    if (environment.aptPackages.length > 0) {
      warnings.push(
        `原生执行不装系统包，已跳过声明的 apt 包：${environment.aptPackages.join(' ')}（判分若确需它们，会以环境失败如实暴露）`,
      );
    }
    if (environment.shellCommands.length > 0) {
      warnings.push(
        `原生执行不重放构建期 shell 步骤，已跳过 ${environment.shellCommands.length} 条：${environment.shellCommands.join(' | ')}`,
      );
    }
    return warnings;
  }

  /**
   * 按环境声明把种子文件摆进应用目录（摆放规则见 {@link TaskSeeder}）。
   *
   * @param task 任务元信息。
   * @param appDir 应用目录。
   * @param warnings 告警收集数组（就地追加）。
   * @returns 无返回值。
   */
  private static seedAppDir(task: TerminalBenchTask, appDir: string, warnings: string[]): void {
    TaskSeeder.seed(task.taskDir, appDir, task.environment.seeds, warnings);
  }

  /**
   * 删除一次性目录树（best-effort）。
   *
   * 链接若还在，先摘链接——`rmSync` 跟随符号链接会删到目标里去。
   *
   * @param parent 一次性目录树的根。
   * @returns 无返回值。
   */
  private static removeTree(parent: string): void {
    for (const name of [APP_DIR_NAME, TESTS_DIR_NAME]) {
      const dir = join(parent, name);
      try {
        if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
          // 符号链接只摘本体（不跟随），否则会删到 /app 映射的真实应用目录里去。
          SafeRemoveTree.remove(dir);
        }
      } catch {
        // best-effort
      }
    }
    try {
      // 逐条目删除，绕开宿主对「单目录条目数过多」的批量删除拦截（见 safeRemoveTree）。
      // 该工具内部已对瞬时占用（EPERM/EBUSY/ENOTEMPTY）做退避重试——实测全量并行时
      // 「工作根残留」正是瞬时占用被这里静默吞掉造成的（2026-09-26 审计）。
      SafeRemoveTree.remove(parent);
    } catch (error) {
      // 到这里就是**真正持久**的失败：残留不可避免，但必须留痕（否则只有断言失败可查）。
      log.warn('tbench.teardown.leftover', {
        parent,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 追加输出并截断到上限（截断时保留尾部，尾部才是失败原因所在）。
   *
   * @param current 已累积文本。
   * @param chunk 新到的字节。
   * @param limit 上限（字节）。
   * @returns 追加后的文本。
   */
  private static append(current: string, chunk: Buffer, limit: number): string {
    const merged = current + chunk.toString('utf8');
    return merged.length <= limit ? merged : merged.slice(merged.length - limit);
  }

  /**
   * 把选项值收敛到合法区间（非有限/非正数视为未提供，落回默认）。
   *
   * @param value 传入值。
   * @param fallback 默认值。
   * @returns 合法取值。
   */
  private static clamp(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.floor(value);
  }

  /**
   * 任务名安全化为目录名片段（去掉路径分隔符与空白）。
   *
   * @param name 任务名。
   * @returns 可安全用作目录名的片段。
   */
  private static slug(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned === '' ? 'task' : cleaned.slice(0, 48);
  }

  /**
   * 列出工作根下残留的一次性目录（可观测性：整轮结束后应为空）。
   *
   * @returns 残留目录名列表。
   */
  public leftoverWorkdirs(): readonly string[] {
    try {
      return NativeExecutionBackend.listDir(this.workRoot);
    } catch {
      return [];
    }
  }

  /**
   * 列举目录项（失败返回空数组）。
   *
   * @param dir 目录。
   * @returns 目录项名列表。
   */
  private static listDir(dir: string): readonly string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  /**
   * 应用根所在盘符（诊断用）。
   *
   * @returns 盘符；无盘符为空串。
   */
  public appRootDrive(): string {
    return parsePath(this.workRoot).root;
  }
}
