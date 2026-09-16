/**
 * 原生本地执行器：免 Docker、免云，在本地用 `git` + `uv` + `pytest` 直接复现 SWE-bench 判定。
 *
 * 定位：替代原先的 LocalDockerExecutor / ModalExecutor（容器/云方案），满足「零 Docker、零云、
 * 完全本地」的诉求。每题流程：git 克隆/检出 base_commit（worktree 隔离）→ `uv` 拉起隔离 venv
 * （按 {@link PythonVersionResolver} 选 Python）→ 安装仓库 + pytest → 应用 model/test 补丁
 * → `pytest` 跑 FAIL_TO_PASS + PASS_TO_PASS → 判定 resolved。
 *
 * 保真度边界（诚实声明）：env 由「仓库自述 + uv 重建」而来，**不等同**官方 Docker 镜像（官方用预建
 * conda 镜像）。用于本地迭代/小批量自测；官方 apples-to-apples 分数建议官方 harness。本实现 fail-closed：
 * 任何设施缺失/异常都返回 resolved=false 并写明原因，绝不静默假绿。
 *
 * @maturity L1 — 判据：best-effort 复现链路（worktree 隔离 + uv venv + 应用补丁 + pytest 判定）已
 *   落地并通过 fail-closed 单测；真实 500 题出分受限于本沙箱无网络（无法克隆/pip），须你侧具备
 *   git + uv + 网络的环境跑出。
 * @maturityEvidence tests/unit/swebenchVerified.test.ts
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SwebenchVerified } from './swebenchVerified.js';
import type { ExecutorPort, VerifiedResult, VerifiedTask } from './swebenchVerified.js';
import { PythonVersionResolver } from './pythonVersionResolver.js';

/** 原生执行器配置。 */
export interface NativeExecutorOptions {
  /** 仓库克隆缓存根目录（按 repo 分目录，避免重复克隆）。 */
  readonly repoCacheRoot?: string;
  /** git 远端基址（缺省 https://github.com/）。 */
  readonly repoBaseUrl?: string;
  /** 保留 worktree/venv（调试用）；缺省执行后清理。 */
  readonly keepWorktree?: boolean;
}

/** 补丁应用结果。 */
interface PatchApply {
  /** 是否全部应用成功。 */
  readonly ok: boolean;
  /** 失败原因（ok=false 时填）。 */
  readonly reason?: string | undefined;
}

/** pytest 运行产物。 */
interface PytestRun {
  /** 标准输出。 */
  readonly stdout: string;
  /** 退出码。 */
  readonly code: number;
}

/**
 * 原生本地执行器：免 Docker、免云，在本地用 `git` + `uv` + `pytest` 直接复现 SWE-bench 判定。
 * 每题：git worktree 检出 base → uv venv → 安装 → 应用补丁 → pytest 判定（fail-closed）。
 */
export class NativeExecutor implements ExecutorPort {
  /** 后端种类标识（固定 native）。 */
  public readonly kind = 'native' as const;

  /** 仓库克隆缓存根目录。 */
  private readonly repoCacheRoot: string;
  /** git 远端基址（缺省 https://github.com/）。 */
  private readonly repoBaseUrl: string;
  /** 是否保留 worktree/venv（调试用，缺省清理）。 */
  private readonly keepWorktree: boolean;
  /** 每仓库串行锁（git worktree add/remove 不可并发同一仓库）。 */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /**
   * 构造原生执行器。
   * @param opts 配置（缓存根/远端基址/是否保留 worktree）。
   */
  public constructor(opts: Readonly<NativeExecutorOptions> = {}) {
    this.repoCacheRoot = opts.repoCacheRoot ?? join(tmpdir(), 'omni-swebench-repos');
    this.repoBaseUrl = opts.repoBaseUrl ?? 'https://github.com/';
    this.keepWorktree = opts.keepWorktree ?? false;
  }

  /** @returns 配置摘要（调试用）。 */
  public describe(): string {
    return `native(cache=${this.repoCacheRoot}, base=${this.repoBaseUrl})`;
  }

  /**
   * 运行单实例：git worktree 检出 base → uv venv → 安装 → 应用补丁 → pytest 判定（fail-closed）。
   * @param task 归一化任务（含 repo/base_commit/version/测试清单）。
   * @param modelPatch 模型生成的补丁（unified diff）。
   * @returns 单实例结果（缺设施/异常即 resolved=false 并写明原因）。
   */
  public async run(task: VerifiedTask, modelPatch: string): Promise<VerifiedResult> {
    if (!SwebenchVerified.commandAvailable('git')) {
      return this.fail(task.id, 'git 不可用（NativeExecutor 需要 git 克隆/检出仓库）');
    }
    if (!SwebenchVerified.commandAvailable('uv')) {
      return this.fail(
        task.id,
        'uv 不可用（NativeExecutor 需要 uv 管理 Python 版本与 venv；安装：https://docs.astral.sh/uv/）',
      );
    }
    let cacheDir: string;
    try {
      cacheDir = await this.prepareRepo(task.repo);
    } catch (error) {
      return this.fail(task.id, `仓库克隆失败: ${this.msg(error)}`);
    }
    const worktree = await this.withRepoLock(task.repo, async () => {
      await this.ensureCommit(cacheDir, task.baseCommit);
      return this.addWorktree(cacheDir, task.baseCommit);
    });
    try {
      const pythonVersion = PythonVersionResolver.resolve(task.repo, task.version);
      await this.setupEnv(worktree, pythonVersion);
      const applied = this.applyPatches(worktree, modelPatch, task.testPatch);
      if (!applied.ok) {
        return this.fail(task.id, applied.reason ?? '补丁应用失败');
      }
      const ids = [...task.failToPass, ...task.passToPass];
      const run = await this.runPytest(worktree, ids);
      const passed = NativeExecutor.parsePytestResults(run.stdout, ids);
      const failToPassOk = task.failToPass.every((id) => passed.get(id) === true);
      const passToPassOk = task.passToPass.every((id) => passed.get(id) === true);
      return { id: task.id, resolved: failToPassOk && passToPassOk, backend: this.kind };
    } catch (error) {
      return this.fail(task.id, `原生执行异常: ${this.msg(error)}`);
    } finally {
      if (!this.keepWorktree) {
        await this.withRepoLock(task.repo, () => this.removeWorktree(cacheDir, worktree));
      }
    }
  }

  /**
   * 从 pytest -v 输出解析各测试 id 的通过情况（纯函数，best-effort）。
   * @param output pytest -v 标准输出。
   * @param ids 待判定的测试 id 列表（FAIL_TO_PASS ∪ PASS_TO_PASS）。
   * @returns id → 是否通过（未出现/非 PASSED 一律 false，fail-closed）。
   */
  public static parsePytestResults(
    output: string,
    ids: readonly string[],
  ): ReadonlyMap<string, boolean> {
    const results = new Map<string, boolean>();
    for (const id of ids) results.set(id, false);
    for (const line of output.split('\n')) {
      const m = /^(.*?)\s+(PASSED|FAILED|ERROR|SKIPPED)(?:\s|\[|$)/.exec(line);
      if (m === null) continue;
      const id = m[1];
      if (id !== undefined && results.has(id.trim())) {
        results.set(id.trim(), m[2] === 'PASSED');
      }
    }
    return results;
  }

  /**
   * 确保 base_commit 存在于缓存克隆中（缺失则 fetch，best-effort）。
   * @param cacheDir 缓存克隆目录。
   * @param base base commit sha。
   * @returns 无。
   */
  private async ensureCommit(cacheDir: string, base: string): Promise<void> {
    try {
      execFileSync('git', ['-C', cacheDir, 'cat-file', '-e', base], { stdio: 'ignore' });
      return;
    } catch {
      // 缺提交：尝试 fetch 全部分支/标签
    }
    try {
      await SwebenchVerified.execFileAsync('git', ['-C', cacheDir, 'fetch', '--all'], cacheDir);
    } catch {
      // 忽略：后续 worktree add 会如实失败并 fail-closed
    }
  }

  /**
   * 准备仓库缓存克隆（不存在则克隆，已存在则复用）。
   * @param repo 仓库 slug。
   * @returns 缓存克隆目录路径。
   */
  private async prepareRepo(repo: string): Promise<string> {
    const safe = repo.replace('/', '__');
    const cacheDir = join(this.repoCacheRoot, safe);
    // 首次运行时缓存根尚不存在，而下面的 clone 以它为 cwd ⇒ 不先建目录会 spawn ENOENT。
    if (!existsSync(this.repoCacheRoot)) mkdirSync(this.repoCacheRoot, { recursive: true });
    if (!existsSync(cacheDir)) {
      await this.withRepoLock(repo, async () => {
        if (!existsSync(cacheDir)) {
          await SwebenchVerified.execFileAsync(
            'git',
            ['clone', `${this.repoBaseUrl}${repo}.git`, cacheDir],
            this.repoCacheRoot,
          );
        }
      });
    }
    return cacheDir;
  }

  /**
   * 为 base_commit 新增一个 detached worktree（隔离工作区）。
   * @param cacheDir 缓存克隆目录。
   * @param base base commit sha。
   * @returns worktree 路径。
   */
  private async addWorktree(cacheDir: string, base: string): Promise<string> {
    const wt = mkdtempSync(join(tmpdir(), 'omni-wt-'));
    rmSync(wt, { recursive: true, force: true });
    await SwebenchVerified.execFileAsync(
      'git',
      ['-C', cacheDir, 'worktree', 'add', '--detach', wt, base],
      cacheDir,
    );
    return wt;
  }

  /**
   * 移除 worktree 并清理目录（best-effort）。
   * @param cacheDir 缓存克隆目录。
   * @param wt worktree 路径。
   * @returns 无。
   */
  private async removeWorktree(cacheDir: string, wt: string): Promise<void> {
    try {
      execFileSync('git', ['-C', cacheDir, 'worktree', 'remove', '--force', wt], {
        stdio: 'ignore',
      });
    } catch {
      // best-effort
    }
    rmSync(wt, { recursive: true, force: true });
  }

  /**
   * 每仓库串行执行（git worktree 操作不可并发同一仓库）。
   * @param repo 仓库 slug（锁键）。
   * @param fn 待执行异步函数。
   * @returns fn 的结果。
   */
  private withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repo) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.repoLocks.set(
      repo,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * 在 worktree 内用 uv 建隔离 venv 并安装仓库 + pytest（best-effort）。
   * @param worktree worktree 路径。
   * @param pythonVersion 目标 Python 版本。
   * @returns 无。
   */
  private async setupEnv(worktree: string, pythonVersion: string): Promise<void> {
    await SwebenchVerified.execFileAsync('uv', ['venv', '--python', pythonVersion], worktree);
    await this.tryInstall(worktree, '.[test]');
    await this.tryInstall(worktree, '.');
    await SwebenchVerified.execFileAsync(
      'uv',
      ['pip', 'install', 'pytest', 'pytest-timeout'],
      worktree,
    );
  }

  /**
   * best-effort 安装仓库（可编辑），失败不阻断（部分仓库装不全仍可跑部分测试）。
   * @param worktree worktree 路径。
   * @param spec 安装规格（如 "." 或 ".[test]"）。
   * @returns 无。
   */
  private async tryInstall(worktree: string, spec: string): Promise<void> {
    try {
      await SwebenchVerified.execFileAsync('uv', ['pip', 'install', '-e', spec], worktree);
    } catch {
      // best-effort：忽略安装失败，继续尝试 pytest
    }
  }

  /**
   * 依次应用 test_patch 与 model_patch（任一失败即判未修复）。
   * @param worktree worktree 路径。
   * @param modelPatch 模型补丁。
   * @param testPatch 官方测试补丁。
   * @returns 应用结果。
   */
  private applyPatches(worktree: string, modelPatch: string, testPatch: string): PatchApply {
    if (!this.gitApply(worktree, testPatch)) {
      return { ok: false, reason: 'test_patch 应用失败（官方测试补丁无法应用）' };
    }
    if (!this.gitApply(worktree, modelPatch)) {
      return { ok: false, reason: 'model_patch 应用失败（模型补丁无法应用，视为未修复）' };
    }
    return { ok: true };
  }

  /**
   * 用 git apply 应用单个补丁文件。
   * @param worktree worktree 路径。
   * @param patch unified diff 文本。
   * @returns 是否应用成功（空补丁视为成功）。
   */
  private gitApply(worktree: string, patch: string): boolean {
    if (patch.trim().length === 0) return true;
    const patchFile = join(worktree, '.omni-apply.patch');
    writeFileSync(patchFile, patch, 'utf8');
    try {
      execFileSync('git', ['apply', '--whitespace=fix', patchFile], {
        cwd: worktree,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    } finally {
      rmSync(patchFile, { force: true });
    }
  }

  /**
   * 计算 worktree 内 venv 的 python 可执行路径（跨平台）。
   * @param worktree worktree 路径。
   * @returns python 可执行文件绝对路径。
   */
  private venvPythonPath(worktree: string): string {
    const isWin = process.platform === 'win32';
    return join(worktree, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  }

  /**
   * 在 venv 内运行 pytest（无论退出码均返回输出，供解析）。
   * @param worktree worktree 路径。
   * @param ids 测试 id 列表。
   * @returns pytest 标准输出与退出码。
   */
  private runPytest(worktree: string, ids: readonly string[]): Promise<PytestRun> {
    const venvPython = this.venvPythonPath(worktree);
    const args = ['-m', 'pytest', ...ids, '-v', '--tb=short', '-p', 'no:cacheprovider'];
    return new Promise<PytestRun>((resolve) => {
      execFile(venvPython, args, { cwd: worktree, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        const code = err !== null && typeof err.code === 'number' ? err.code : 0;
        resolve({ stdout: stdout ?? '', code });
      });
    });
  }

  /**
   * 构造未通过结果。
   * @param instanceId 实例 id。
   * @param reason 原因。
   * @returns 未通过结果。
   */
  private fail(instanceId: string, reason: string): VerifiedResult {
    return { id: instanceId, resolved: false, backend: 'native', reason };
  }

  /**
   * 把未知错误归一为可读字符串。
   * @param error 错误。
   * @returns 可读消息。
   */
  private msg(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
      return String((error as { message?: unknown }).message ?? error);
    }
    return String(error);
  }
}
