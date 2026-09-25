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
 * 任何设施缺失/异常都返回 resolved=false 并写明原因（环境构建失败额外标 `envError`，与模型未解出区分、
 * 不计入 resolved 率分母、可单独重试）；绝不静默假绿。依赖安装带有限重试+退避，缓解实时网络抖动导致的
 * 评测不可复现。
 *
 * @maturity L1 — 判据：best-effort 复现链路（worktree 隔离 + uv venv + 应用补丁 + pytest 判定）已
 *   落地并通过 fail-closed 单测；真实 500 题出分受限于本沙箱无网络（无法克隆/pip），须你侧具备
 *   git + uv + 网络的环境跑出。
 * @maturityEvidence tests/unit/swebenchVerified.test.ts
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { endpointDefaults } from '../util/endpointDefaults.js';
import { SwebenchVerified } from './swebenchVerified.js';
import type { ExecutorPort, VerifiedResult, VerifiedTask } from './swebenchVerified.js';
import { PythonVersionResolver } from './pythonVersionResolver.js';
import { PytestVerdict } from './pytestVerdict.js';
import { NativeEnvBuilder, ENV_BUILD_FAILED } from './nativeEnvBuilder.js';
import { UvLocator } from './uvLocator.js';
import type { UvLookup } from './uvLocator.js';

/** 候选补丁的验证结果。 */
export interface ScoreResult {
  /** 0..1 的奖励（FAIL_TO_PASS 通过比例）。 */
  readonly reward: number;
  /** 未通过的 FAIL_TO_PASS 测试 id（供 self-test 反馈环回喂模型）。 */
  readonly failures: readonly string[];
}

/** 原生执行器配置。 */
export interface NativeExecutorOptions {
  /** 仓库克隆缓存根目录（按 repo 分目录，避免重复克隆）。 */
  readonly repoCacheRoot?: string;
  /** git 远端基址（缺省 https://github.com/）。 */
  readonly repoBaseUrl?: string;
  /**
   * 上游仓库 slug → 镜像仓库 slug 的映射（缺省空 = 直连上游命名空间）。
   * 用途：受限网络下改用国内镜像站，而镜像站的命名空间常与上游不同
   * （Gitee 官方镜像把仓库放在 `mirrors/` 组织下：`django/django` → `mirrors/django`）。
   * 未命中映射时按原 slug 拼接，行为与不带本选项完全一致（零行为变更）。
   */
  readonly repoMirrors?: Readonly<Record<string, string>>;
  /**
   * 上游仓库 slug → 额外 pip 约束（逐条形如 `Werkzeug<3`）的映射，在基础安装之后、确保 pytest 之前应用。
   *
   * 用途：修复**保真度缺口**——老仓库常把**开发期运行时依赖**声明为不设上界的范围
   * （如 flask 2.3.0.dev 的 `Werkzeug>=2.2.2`）；今天解析会拉到最新主版本（werkzeug 3.x 删除了
   * `werkzeug.__version__`），使 2023 年的测试套件在 2026 年直接崩。官方 harness 用**预建 conda
   * 镜像**规避此问题；本原生执行器无镜像，故以「仓库自述 + 显式约束」best-effort 逼近。
   * 未命中映射时零行为变更。见 `benchmark/swebench-env-pins.json`。
   */
  readonly envPins?: Readonly<Record<string, readonly string[]>>;
  /** 保留 worktree/venv（调试用）；缺省执行后清理。 */
  readonly keepWorktree?: boolean;
  /**
   * uv 定位函数（缺省 {@link UvLocator.locate}）。
   * 注入点用于「uv 缺失时的报错可执行性」单测——不必真的卸载 uv 才能验证 fail-closed 路径。
   */
  readonly uvLocator?: (() => UvLookup) | undefined;
}

/** 补丁应用结果。 */
interface PatchApply {
  /** 是否全部应用成功。 */
  readonly ok: boolean;
  /** 失败原因（ok=false 时填）。 */
  readonly reason?: string | undefined;
  /**
   * 失败是否属**执行设施/环境**层面（官方 test_patch 都应用不上 ⇒ 该实例未进入模型能力判定）。
   * 为 true 时上层标 `envError`、不污染 resolved 率分母。
   */
  readonly envFailure?: boolean | undefined;
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
  /** 上游 slug → 镜像 slug 映射（见 {@link NativeExecutorOptions.repoMirrors}）。 */
  private readonly repoMirrors: Readonly<Record<string, string>>;
  /** 上游 slug → 额外 pip 约束（见 {@link NativeExecutorOptions.envPins}）。 */
  private readonly envPins: Readonly<Record<string, readonly string[]>>;
  /** 是否保留 worktree/venv（调试用，缺省清理）。 */
  private readonly keepWorktree: boolean;
  /** uv 定位函数（见 {@link NativeExecutorOptions.uvLocator}）。 */
  private readonly uvLocate: () => UvLookup;
  /** 环境构建器（uv venv + 依赖阶梯 + pytest 存在性校验）。 */
  private readonly envBuilder: NativeEnvBuilder;
  /** 每仓库串行锁（git worktree add/remove 不可并发同一仓库）。 */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /**
   * 构造原生执行器。
   * @param opts 配置（缓存根/远端基址/镜像映射/环境约束/是否保留 worktree/uv 定位）。
   */
  public constructor(opts: Readonly<NativeExecutorOptions> = {}) {
    this.repoCacheRoot = opts.repoCacheRoot ?? join(tmpdir(), 'omni-swebench-repos');
    this.repoBaseUrl = opts.repoBaseUrl ?? endpointDefaults.urlOf('gitRemoteBase');
    this.repoMirrors = opts.repoMirrors ?? {};
    this.envPins = opts.envPins ?? {};
    this.keepWorktree = opts.keepWorktree ?? false;
    this.uvLocate = opts.uvLocator ?? (() => UvLocator.locate());
    this.envBuilder = new NativeEnvBuilder(this.envPins);
  }

  /**
   * 配置摘要（调试用）。
   * @returns 形如 `native(cache=..., base=..., mirrors=N, pins=M)` 的一行摘要。
   */
  public describe(): string {
    const uv = this.uvLocate().executable;
    return `native(cache=${this.repoCacheRoot}, base=${this.repoBaseUrl}, mirrors=${Object.keys(this.repoMirrors).length}, pins=${Object.keys(this.envPins).length}, uv=${uv ?? '缺少'})`;
  }

  /**
   * 运行单实例：git worktree 检出 base → uv venv → 安装 → 应用补丁 → pytest 判定（fail-closed）。
   * @param task 归一化任务（含 repo/base_commit/version/测试清单）。
   * @param modelPatch 模型生成的补丁（unified diff）。
   * @returns 单实例结果（缺设施/异常/空 FAIL_TO_PASS 即 resolved=false 并写明原因）。
   */
  public async run(task: VerifiedTask, modelPatch: string): Promise<VerifiedResult> {
    // fail-open 防线（与 SwebenchVerified.parseTestList 的加载期校验互为纵深）：
    // `failToPass` 为空时 `[].every(...)` 恒真 ⇒ 任何补丁都会被误判 resolved。VerifiedTask 可由
    // 任意调用方手工构造（不必经 loadVerified），故执行边界再兜一次，宁可拒判也不假绿。
    if (task.failToPass.length === 0) {
      return this.failEnv(
        task.id,
        'FAIL_TO_PASS 为空 —— 拒绝判定（空清单会使「全过=resolved」恒真，属 fail-open 假绿）',
      );
    }
    if (!SwebenchVerified.commandAvailable('git')) {
      return this.failEnv(task.id, 'git 不可用（NativeExecutor 需要 git 克隆/检出仓库）');
    }
    // uv 定位不止看 PATH：官方安装脚本默认落在 ~/.local/bin（本机实测不在 PATH 上），
    // 只查 PATH 会把「装了但没配 PATH」误报成「没装」，让整条判定链路无声 fail-closed。
    let uv: string;
    try {
      uv = this.requireUv();
    } catch (error) {
      return this.failEnv(task.id, this.msg(error));
    }
    let cacheDir: string;
    try {
      cacheDir = await this.prepareRepo(task.repo);
    } catch (error) {
      return this.failEnv(task.id, `仓库克隆失败: ${this.msg(error)}`);
    }
    // 注：`ensureCommit` 刻意吞掉取回失败（见其实现），把判定权交给随后的 `addWorktree`；
    // 因此这里**必须**兜住 worktree 抛出——残留/半克隆的缓存会把 `git worktree add --detach <base>`
    // 变成 `fatal: invalid reference`（真实现场：Temp 下遗留的 django__django 半克隆）。
    // 旧实现未兜：异常直接逃出 `run()`，使「fail-closed」在这一步退化成**抛错**，
    // 500 题批量跑分时会整批中断而非逐题记「未通过」。此处补齐，与下方 try 块口径一致。
    let worktree: string;
    try {
      worktree = await this.withRepoLock(task.repo, async () => {
        await this.ensureCommit(cacheDir, task.baseCommit);
        return this.addWorktree(cacheDir, task.baseCommit);
      });
    } catch (error) {
      return this.failEnv(task.id, `工作区检出失败: ${this.msg(error)}`);
    }
    try {
      const pythonVersion = PythonVersionResolver.resolve(task.repo, task.version);
      await this.envBuilder.build(worktree, pythonVersion, task.repo, uv);
      const applied = this.applyPatches(worktree, modelPatch, task.testPatch);
      if (!applied.ok) {
        const reason = applied.reason ?? '补丁应用失败';
        return applied.envFailure === true
          ? this.failEnv(task.id, reason)
          : this.fail(task.id, reason);
      }
      const ids = [...task.failToPass, ...task.passToPass];
      // 测试文件取自官方 test_patch 的头（见 testFilesOf）：官方 harness 是「跑 test_patch 改动的
      // 测试文件 + 按 -rA 比对名字」，而非把 FAIL_TO_PASS 名字直接当 pytest 参数（后者对 sympy 等
      // 给**裸测试名**的仓库会 0 收集 ⇒ 判定恒假，实测 gold 都判不过）。
      const testFiles = PytestVerdict.testFilesOf(task.testPatch);
      const run = await this.runPytest(worktree, testFiles, ids);
      const passed = PytestVerdict.parseResults(run.stdout, ids);
      const failToPassOk = task.failToPass.every((id) => passed.get(id) === true);
      const passToPassOk = task.passToPass.every((id) => passed.get(id) === true);
      return { id: task.id, resolved: failToPassOk && passToPassOk, backend: this.kind };
    } catch (error) {
      const msg = this.msg(error);
      // 环境构建失败（pytest 未装入 venv）与「模型未解出/执行异常」严格区分：前者是执行设施缺失，
      // 该实例未进入 pytest 判定，标 envError 以便单独重试、且不污染 resolved 率分母。
      if (msg.startsWith(ENV_BUILD_FAILED)) {
        return this.failEnv(task.id, msg);
      }
      return this.fail(task.id, `原生执行异常: ${msg}`);
    } finally {
      if (!this.keepWorktree) {
        await this.withRepoLock(task.repo, () => this.removeWorktree(cacheDir, worktree));
      }
    }
  }

  /**
   * 在**外部**工作区（由调用方已 checkout 到 base_commit）内准备可运行 Python 环境：
   * 用 `uv` 建隔离 venv 并按下还安装阶梯装好仓库 + pytest。**不**重新克隆/检出（调用方负责）。
   *
   * 用途：best-of-N 与 self-test 模式需要在一份已检出工作区上**复用同一 venv** 反复跑候选补丁，
   * 而非每候选都重建环境（那会让 8× 实例的验证成本爆炸）。返回 venv 的 python 可执行路径，
   * 供调用方在 `scorePatch` / `runPytest` 中复用。
   * @param worktree 已检出到 base_commit 的工作区路径。
   * @param task 归一化任务（取 repo/version 决定 Python 版本与额外约束）。
   * @returns venv 的 python 可执行路径。
   */
  public async prepareRuntime(worktree: string, task: VerifiedTask): Promise<string> {
    const pythonVersion = PythonVersionResolver.resolve(task.repo, task.version);
    await this.envBuilder.build(worktree, pythonVersion, task.repo, this.requireUv());
    return NativeEnvBuilder.pythonPath(worktree);
  }

  /**
   * 在已准备环境的工作区上**就地**对单个候选补丁验证：应用 test_patch + 候选补丁，
   * 跑官方 FAIL_TO_PASS（gold 信号），返回「通过比例」与「未通过项列表」，随后把工作区 git 回滚到
   * 干净态（保留 `.venv`）。任一环节失败（补丁不可应用 / 缺设施）均返回 reward=0、failures=全部
   * （fail-closed，不假绿）。
   *
   * 这是 best-of-N 的「可验证奖励」信号源：reward 高 = 该候选让更多官方失败测试转绿；
   * `failures` 同时供 self-test 把未通过测试名回喂修复环（测试驱动自纠）。
   * 复用同一 worktree + venv ⇒ N 个候选的边际成本仅是「应用+跑测试+回滚」。
   * @param task 归一化任务（含 testPatch/failToPass）。
   * @param modelPatch 候选补丁（unified diff）。
   * @param worktree 已 prepareRuntime 的工作区。
   * @returns 验证结果（reward + 未通过项）。
   */
  public async scorePatch(
    task: VerifiedTask,
    modelPatch: string,
    worktree: string,
  ): Promise<ScoreResult> {
    if (task.failToPass.length === 0) return { reward: 0, failures: [] }; // 无信号
    const applied = this.applyPatches(worktree, modelPatch, task.testPatch);
    if (!applied.ok) {
      // 回滚工作区到干净态（保留 .venv）：apply 失败时仍丢弃已应用的 test_patch 残留。
      try {
        execFileSync('git', ['-C', worktree, 'checkout', '--', '.'], { stdio: 'ignore' });
      } catch {
        // best-effort
      }
      try {
        execFileSync('git', ['-C', worktree, 'clean', '-fd', '-e', '.venv', '-e', 'venv'], {
          stdio: 'ignore',
        });
      } catch {
        // best-effort
      }
      return { reward: 0, failures: task.failToPass };
    }
    try {
      const ids = task.failToPass;
      const testFiles = PytestVerdict.testFilesOf(task.testPatch);
      const run = await this.runPytest(worktree, testFiles, ids);
      const passed = PytestVerdict.parseResults(run.stdout, ids);
      const failed = task.failToPass.filter((id) => passed.get(id) !== true);
      const ok = task.failToPass.length - failed.length;
      return { reward: ok / task.failToPass.length, failures: failed };
    } catch {
      return { reward: 0, failures: task.failToPass };
    } finally {
      // 回滚工作区到干净态（丢弃补丁与新增测试文件），但**保留 `.venv`/`venv`**：
      // 复用 worktree 反复验证时回滚须只清补丁副作用、不动 venv，否则下次验证需重建环境。
      // `git clean -fd` 默认尊重 `.gitignore`（.venv 通常已忽略），再显式 -e 双保险。
      try {
        execFileSync('git', ['-C', worktree, 'checkout', '--', '.'], { stdio: 'ignore' });
      } catch {
        // best-effort：无已修改追踪文件时 checkout 空转
      }
      try {
        execFileSync('git', ['-C', worktree, 'clean', '-fd', '-e', '.venv', '-e', 'venv'], {
          stdio: 'ignore',
        });
      } catch {
        // best-effort
      }
    }
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
   *
   * 镜像重定向：`repo` 是 SWE-bench 的**上游 slug**（如 `django/django`），而镜像站常把仓库
   * 放在不同命名空间下（Gitee 官方镜像全在 `mirrors/` 组织 ⇒ `mirrors/django`）。故克隆 URL 的
   * slug 走 `repoMirrors` 映射，而**缓存目录仍按上游 slug 命名**——这样换镜像源不会导致缓存失效，
   * 实例 id 与缓存路径保持稳定。
   * @param repo 上游仓库 slug（如 `django/django`）。
   * @returns 缓存克隆目录路径。
   */
  private async prepareRepo(repo: string): Promise<string> {
    const safe = repo.replace('/', '__');
    const cacheDir = join(this.repoCacheRoot, safe);
    const slug = this.repoMirrors[repo] ?? repo;
    // 首次运行时缓存根尚不存在，而下面的 clone 以它为 cwd ⇒ 不先建目录会 spawn ENOENT。
    if (!existsSync(this.repoCacheRoot)) mkdirSync(this.repoCacheRoot, { recursive: true });
    if (!existsSync(cacheDir)) {
      await this.withRepoLock(repo, async () => {
        if (!existsSync(cacheDir)) {
          await SwebenchVerified.execFileAsync(
            'git',
            ['clone', `${this.repoBaseUrl}${slug}.git`, cacheDir],
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
   * 依次应用 test_patch 与 model_patch（任一失败即判未修复）。
   * @param worktree worktree 路径。
   * @param modelPatch 模型补丁。
   * @param testPatch 官方测试补丁。
   * @returns 应用结果。
   */
  private applyPatches(worktree: string, modelPatch: string, testPatch: string): PatchApply {
    if (!this.gitApply(worktree, testPatch)) {
      // 官方 test_patch 应用不上：**不是模型的锅**，该实例压根没进入模型能力判定 ⇒ 标 envFailure。
      return {
        ok: false,
        envFailure: true,
        reason: 'test_patch 应用失败（官方测试补丁无法应用）',
      };
    }
    if (!this.gitApply(worktree, modelPatch)) {
      return { ok: false, reason: 'model_patch 应用失败（模型补丁无法应用，视为未修复）' };
    }
    return { ok: true };
  }

  /**
   * 应用单个补丁文件：先 `git apply`，失败则回退 GNU `patch --fuzz=5`（best-effort）。
   *
   * 为什么需要回退：`git apply` 要求 hunk 的**行号与上下文逐行精确匹配**，而模型补丁（以及部分官方
   * 测试补丁）常带轻微偏移——多一个空行、少一行 import、上下文取了相邻函数。此时补丁**语义正确却
   * 应用失败**，会把「能修的题」错记成「未修复」，系统性低估分数。`.rej` 侧不回退（宁可漏、不可假绿）。
   * GNU patch 的模糊匹配（`--fuzz=5`）与主流 harness（SWE-agent 等）同口径；应用后仍由 pytest 判定，
   * 故**不会**造成假绿——补丁若语义错误，测试照样不过。
   * 补丁经 **stdin** 喂给 `git apply -` / `patch`，不再落临时文件：早期实现每题写一次
   * `.omni-apply.patch` 再 `rmSync` 删除，批量跑分（数百次删除）会撞上宿主的「批量删除需确认」
   * 安全栅栏，导致整批在删除处抛错、把能跑的实例误记为失败（2026-09-17 实测 16/16 全败于该栅栏）。
   * 走 stdin 后**零临时文件、零删除**，栅栏无从触发，且语义等价。
   * @param worktree worktree 路径。
   * @param patch unified diff 文本。
   * @returns 是否应用成功（空补丁视为成功）。
   */
  private gitApply(worktree: string, patch: string): boolean {
    if (patch.trim().length === 0) return true;
    try {
      // 第一段：严格匹配（`-` ⇒ 从 stdin 读补丁）。多数干净补丁在此通过。
      try {
        execFileSync('git', ['apply', '--whitespace=fix', '-'], {
          cwd: worktree,
          stdio: ['pipe', 'ignore', 'ignore'],
          input: patch,
        });
        return true;
      } catch {
        // 第二段：模糊匹配回退（不传 -i ⇒ patch 从 stdin 读；-p1 剥离 a/ b/ 前缀；
        // --batch 不交互；不遗留 .orig 备份）。
        execFileSync('patch', ['--batch', '--fuzz=5', '-p1', '--no-backup-if-mismatch'], {
          cwd: worktree,
          stdio: ['pipe', 'ignore', 'ignore'],
          input: patch,
        });
        return true;
      }
    } catch {
      return false;
    }
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
  ): Promise<PytestRun> {
    const venvPython = NativeEnvBuilder.pythonPath(worktree);
    const args =
      testFiles.length > 0
        ? ['-m', 'pytest', ...testFiles, '-rA', '--tb=no', '-p', 'no:cacheprovider']
        : ['-m', 'pytest', ...ids, '-v', '--tb=short', '-p', 'no:cacheprovider'];
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
   * 构造**环境失败**结果（`envError: true`）——用于「执行设施/环境把该实例打断、根本没进入模型能力判定」
   * 的四类现场：缺 git/uv、仓库克隆失败、工作区检出失败、官方 test_patch 应用失败（另加空 FAIL_TO_PASS
   * 这类数据集缺陷）。报告侧据此把它们从 resolved 率**分母**里剔除并单独重试。
   *
   * 为什么必须分开（2026-09-25 实测）：沙箱阻断 piped-stdio 子进程时，`git worktree add` 抛
   * `spawn EPERM`，旧实现把它记成**模型失败**（13/13 全记模型失败、envErrors=0）——一次环境事故
   * 会被读成「模型 0 分」，正是本仓反复治的假信号。
   * @param instanceId 实例 id。
   * @param reason 失败原因（原样进报告，便于定位与重试）。
   * @returns 带 envError 标记的未通过结果。
   */
  private failEnv(instanceId: string, reason: string): VerifiedResult {
    return { id: instanceId, resolved: false, backend: 'native', envError: true, reason };
  }

  /**
   * 解析 uv 可执行文件绝对路径；缺失即抛错。
   *
   * 错误文本中必须带「已查找哪些位置」与 `OMNI_UV` 出口：原实现只报一句「uv 不可用」，
   * 而本机实测的现场恰恰是「uv 装在 ~/.local/bin 但不在 PATH 上」——没有这两个信息，
   * 使用者只会以为「没装 uv」，实际上重装也解决不了。
   *
   * @returns uv 可执行文件绝对路径。
   */
  private requireUv(): string {
    const uv = this.uvLocate();
    if (uv.executable === null) {
      throw new Error(
        'uv 不可用（NativeExecutor 需要 uv 管理 Python 版本与 venv；安装：https://docs.astral.sh/uv/）' +
          `。已查找：${uv.searched.join(' | ')}` +
          `；若已安装，用 ${UvLocator.ENV_KEY} 指定其绝对路径，或把它所在目录加入 PATH`,
      );
    }
    return uv.executable;
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
