/**
 * 测试执行协作者（从 `NativeExecutor` 按职责拆出，见「成员数越线 ⇒ 抽协作者」范式）。
 *
 * 为什么不留在执行器里：加入 per-repo 规格（{@link RepoTestSpecs}）后 `NativeExecutor` 方法数越过了
 * 本仓「上帝类」红线（>25 方法）——按纪律**找职责缝抽协作者**，而不是删注释凑数。
 * 本类只负责「把测试跑起来并给出 id→是否通过」，不碰 git/venv/补丁。
 *
 * 两条路径：
 *  - **per-repo 规格**（如 django 的 `runtests.py`）：合并 stdout+stderr（unittest 结果行走 stderr）；
 *  - **默认 pytest 路径**：测试文件取自 `test_patch`，`-rA` 列全量结果后按叶子名比对。
 */
import { execFile } from 'node:child_process';
import { NativeEnvBuilder } from './nativeEnvBuilder.js';
import { PytestVerdict } from './pytestVerdict.js';
import { RepoTestSpecs } from './repoTestSpecs.js';
import type { VerifiedTask } from './swebenchVerified.js';

/** 测试运行产物。 */
interface TestRun {
  /** 标准输出（per-repo 路径下为 stdout 与 stderr 的合并文本）。 */
  readonly stdout: string;
  /** 退出码。 */
  readonly code: number;
}

/**
 * 测试执行协作者：把「跑测试 + 按仓库口径解析」从执行器里独立出来（无 git/venv/补丁职责）。
 */
export class NativeTestRunner {
  /**
   * 跑一个实例的测试并**按仓库口径**解析结果。
   *
   * 官方 judge 与 best-of-N 的可验证奖励**共用本方法**，避免两处口径分叉。
   * @param task 归一化任务。
   * @param worktree worktree 路径（venv 须已就绪）。
   * @param ids 测试 id 列表。
   * @returns id → 是否通过（缺项视为未通过，fail-closed）。
   */
  public async runFor(
    task: VerifiedTask,
    worktree: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const spec = RepoTestSpecs.for(task.repo);
    if (spec !== null) {
      const run = await this.runCommand(worktree, spec.argsOf(ids, { testPatch: task.testPatch }));
      return spec.parse(run.stdout, ids);
    }
    const testFiles = PytestVerdict.testFilesOf(task.testPatch);
    const run = await this.runPytest(worktree, testFiles, ids);
    return PytestVerdict.parseResults(run.stdout, ids);
  }

  /**
   * 用 venv 的解释器执行**显式参数**的测试命令，返回 stdout+stderr 合并输出。
   *
   * 与 `runPytest` 的关键差别：**同时收 stderr**——django 的 `runtests.py`（unittest TextTestRunner）
   * 把结果行写到 stderr，只收 stdout 会把「全过」读成「零收集 ⇒ 恒未通过」。
   * @param worktree worktree 路径。
   * @param args 解释器之后的参数（见 {@link RepoTestSpec.argsOf}）。
   * @returns 合并输出与退出码。
   */
  private runCommand(worktree: string, args: readonly string[]): Promise<TestRun> {
    const venvPython = NativeEnvBuilder.pythonPath(worktree);
    return new Promise<TestRun>((resolve) => {
      execFile(
        venvPython,
        [...args],
        { cwd: worktree, maxBuffer: 128 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err !== null && typeof err.code === 'number' ? err.code : 0;
          resolve({ stdout: `${stdout ?? ''}\n${stderr ?? ''}`, code });
        },
      );
    });
  }

  /**
   * 在 venv 内运行 pytest（无论退出码均返回输出，供解析）。
   *
   * 有测试文件（来自 test_patch）⇒ 跑整份文件并 `-rA` 列全量结果，再按**叶子名**比对 —— 对齐官方口径，
   * 且能覆盖「FAIL_TO_PASS 给裸测试名」的仓库（裸名当参数会被 pytest 当路径 ⇒ 0 收集 ⇒ 恒假）。
   * 无测试文件 ⇒ 退回按 id 直跑（保持历史行为，兼容完整 nodeid 的仓库）。
   * @param worktree worktree 路径。
   * @param testFiles test_patch 改动的测试文件（可为空）。
   * @param ids 测试 id 列表（无测试文件时的直跑参数）。
   * @returns pytest 标准输出与退出码。
   */
  private runPytest(
    worktree: string,
    testFiles: readonly string[],
    ids: readonly string[],
  ): Promise<TestRun> {
    const venvPython = NativeEnvBuilder.pythonPath(worktree);
    const args =
      testFiles.length > 0
        ? ['-m', 'pytest', ...testFiles, '-rA', '--tb=no', '-p', 'no:cacheprovider']
        : ['-m', 'pytest', ...ids, '-v', '--tb=short', '-p', 'no:cacheprovider'];
    return new Promise<TestRun>((resolve) => {
      execFile(venvPython, args, { cwd: worktree, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        const code = err !== null && typeof err.code === 'number' ? err.code : 0;
        resolve({ stdout: stdout ?? '', code });
      });
    });
  }
}
