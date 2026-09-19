/**
 * 原生评测环境构建器：在已检出的工作区内用 `uv` 建隔离 venv、按阶梯装齐依赖与 pytest。
 *
 * ## 为什么要单独一个类
 *
 * 这段逻辑与 `NativeExecutor` 的「实例编排」职责正交：编排关心「补丁能不能应用、测试跑出什么」，
 * 而这里只关心「Python 环境能不能立起来」。把它独立出来有两个直接好处：
 * ① 环境构建是**可独立复现**的一段（best-of-N / self-test 也复用同一构建路径），独立成类后
 *    调用方不必持有执行器；
 * ② `NativeExecutor` 已接近「一文件一类 / 上帝类」红线的实现体量，继续往里塞设施细节会越线。
 *
 * ## 两条纪律
 *
 * 1. **不覆盖仓库自述的测试设施版本**：安装阶梯见 {@link PythonEnvPlan.steps}，其中最末步
 *    「仅在 pytest 缺失时安装」是修复「registry-latest pytest 顶掉仓库 pin」的关键。
 * 2. **环境失败与模型失败严格区分**：pytest 最终没进 venv ⇒ 抛 {@link ENV_BUILD_FAILED} 前缀的错误，
 *    由 `NativeExecutor` 标记 `envError`（不计入 resolved 率分母、可单独重试），绝不静默当成
 *    「模型没解出来」。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SwebenchVerified } from './swebenchVerified.js';
import { PythonEnvPlan } from './pythonEnvPlan.js';

/**
 * 环境构建失败哨兵前缀：{@link NativeEnvBuilder.build} 校验到 pytest 未装入 venv 时抛出的错误以本
 * 前缀开头，`NativeExecutor.run` 据此前缀把该实例标记为 `envError`（区别于模型未解出），便于
 * 单独重试、且不污染 resolved 率。
 */
export const ENV_BUILD_FAILED = 'ENV_BUILD_FAILED:';

/** 原生评测环境构建器（uv venv + 依赖阶梯 + pytest 存在性校验）。 */
export class NativeEnvBuilder {
  /** 上游仓库 slug → 额外 pip 约束（见 `NativeExecutorOptions.envPins`）。 */
  private readonly envPins: Readonly<Record<string, readonly string[]>>;

  /**
   * @param envPins 上游仓库 slug → 额外 pip 约束（如 `Werkzeug<3`），在基础安装之后应用。
   */
  public constructor(envPins: Readonly<Record<string, readonly string[]>> = {}) {
    this.envPins = envPins;
  }

  /**
   * 计算 worktree 内 venv 的 python 可执行路径（跨平台）。
   *
   * @param worktree worktree 路径。
   * @returns python 可执行文件绝对路径。
   */
  public static pythonPath(worktree: string): string {
    const isWin = process.platform === 'win32';
    return join(worktree, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  }

  /**
   * 构建（或重建）可运行环境：`uv venv --clear` → 按阶梯安装 → 校验 pytest 真装入 venv。
   *
   * `--clear` 是刻意的：跨运行复用同一工作区时，上一次崩溃可能已留下 `.venv`，`uv venv` 会拒绝覆盖
   * 并让整个验证环境准备失败、best-of-N/self-test 全被跳过。清掉重建（每个实例只调一次，成本可忽略；
   * 且绝不动 `.venv` 内容之外的文件）。
   *
   * @param worktree worktree 路径。
   * @param pythonVersion 目标 Python 版本。
   * @param repo 上游仓库 slug（用于取该仓库的额外约束）。
   * @param uv uv 可执行文件绝对路径（由 `NativeExecutor` 经 `UvLocator` 解析后传入）。
   * @returns 无。
   */
  public async build(
    worktree: string,
    pythonVersion: string,
    repo: string,
    uv: string,
  ): Promise<void> {
    await SwebenchVerified.execFileAsync(
      uv,
      ['venv', '--clear', '--python', pythonVersion],
      worktree,
    );
    const steps = PythonEnvPlan.steps({
      requirementsFile: PythonEnvPlan.findTestRequirements((rel) =>
        existsSync(join(worktree, rel)),
      ),
      pins: this.envPins[repo] ?? [],
      pytestPresent: NativeEnvBuilder.hasModule(worktree, 'pytest'),
    });
    for (const step of steps) {
      await this.install(worktree, step.args, uv);
    }
    // 环境构建后校验 pytest 真装入 venv：best-effort 安装在实时网络/pypi 镜像抖动下可能全盘失败，
    // 若继续跑 pytest 会把「环境故障」误记为「模型未解出」。显式抛出哨兵错误交由上层标记 envError。
    if (!NativeEnvBuilder.hasModule(worktree, 'pytest')) {
      throw new Error(
        `${ENV_BUILD_FAILED}pytest 未能装入 venv（依赖安装失败，疑实时网络/pypi 镜像不可达）`,
      );
    }
  }

  /**
   * 判断 venv 内是否已可导入某模块（用于「仅在缺失时安装」，避免覆盖仓库 pin）。
   *
   * @param worktree worktree 路径。
   * @param module 模块名（须为合法 Python 标识符，否则直接判否）。
   * @returns 可导入返回 true。
   */
  private static hasModule(worktree: string, module: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(module)) return false;
    try {
      execFileSync(NativeEnvBuilder.pythonPath(worktree), ['-c', `import ${module}`], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * best-effort 安装（失败不阻断：部分仓库装不全仍可跑部分测试）。**带有限重试+线性退避**：
   * 实时网络/pypi 镜像偶发抖动时自动自愈，避免把「瞬时装不上」误记为「模型未解出」。
   *
   * @param worktree worktree 路径。
   * @param args `uv pip install` 的参数（如 `['-e', '.']` 或 `['-r', 'requirements/tests.txt']`）。
   * @param uv uv 可执行文件绝对路径。
   * @returns 无。
   */
  private async install(worktree: string, args: readonly string[], uv: string): Promise<void> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await SwebenchVerified.execFileAsync(
          uv,
          ['pip', 'install', '--python', NativeEnvBuilder.pythonPath(worktree), ...args],
          worktree,
        );
        return;
      } catch (error) {
        lastErr = error;
        if (attempt < MAX_ATTEMPTS) {
          // 退避：第 1 次失败等 1s、第 2 次等 2s 再重试（网络抖动多可自恢复）。
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    // best-effort：忽略安装失败，交给 build() 末尾的 pytest 校验兜底（区分环境失败与模型失败）。
    void lastErr;
  }
}
