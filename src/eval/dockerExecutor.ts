/**
 * Docker 官方镜像执行器：用 SWE-bench 官方预建镜像（`swebench/sweb.eval.x86_64.<instance_id>:v1`）
 * 判定 resolved，补齐 {@link NativeExecutor}（uv 本地重建环境）在**编译型仓库**上的保真度缺口
 * ——astropy/matplotlib/scikit-learn 等仓库本体装不进本地 venv（缺 C/C++ 工具链/预编译依赖），
 * 官方镜像自带预编译 conda env（`testbed`），与官方 harness apples-to-apples。
 *
 * 官方语义对齐（SWE-bench harness 2.1.8，即本批预建镜像的同代版本）：
 *  - 镜像名：instance_id 的 `__` → `_1776_`（官方命名规则，见 harness 的 image key 约定）；
 *  - eval 流程：容器内 `/testbed`（镜像构建时已置于 base_commit）→ 应用 model patch
 *    （`git apply`，失败回退 `patch --batch --fuzz=5`，与官方 `run_instance` 同口径）→
 *    把 test_patch 涉及文件重置到 base → 应用 test patch（heredoc）→ 官方 per-repo test_cmd；
 *  - test_cmd（2.1.8 `constants.py`）：本执行器登记的 pytest 类仓库一律
 *    `pytest --no-header -rA --tb=no -p no:cacheprovider`；
 *  - conda env：`source /opt/miniconda3/bin/activate && conda activate testbed`（2.1.8 `env_name="testbed"`）。
 *
 * 脚本经 **stdin** 送入 `docker run -i … bash -s`：不挂载宿主目录、不 `docker cp`，
 * 规避 Docker Desktop 的盘符共享配置差异；测试日志从容器 stdout 直接回捕。
 *
 * 受限网络：Docker Hub 直连不可达时按 `mirrorBases` 前缀逐个尝试拉取，成功后 `docker tag`
 * 回官方名（判分脚本只认官方名）。每个源一次尝试，全败即 envError（可重试）。
 *
 * fail-closed：docker CLI 缺失 / 镜像拉取失败 / 官方 test_patch 应用失败 / 测试超时 /
 * 仓库未登记官方 test_cmd → `envError`（未进入能力判定，不计入 resolved 率分母，可单独重试）；
 * model patch 应用失败 → `resolved=false`（模型的锅，与官方「补丁打不上即 0 分」同口径）。
 * 解析复用 {@link PytestVerdict}（`-rA`/`-v` 两形态 + 叶子名比对），未通过原因复用
 * {@link NativeTestRunner.describeFailure}（F2P/P2P 计数 + 短诊断），保证报告口径与 native 一致。
 *
 * 范围边界（诚实声明）：只登记官方 test_cmd 为 pytest 的仓库（Verified-30 环境受阻的 6 个
 * astropy/matplotlib/scikit-learn/xarray/sphinx/pytest 实例全在此列）；django/sympy 已由
 * native 路径 gold 背书，无需镜像。未登记仓库返回 envError 并写明原因，**绝不静默回落**到
 * 未经实证的命令。
 *
 * @maturity L1 — 判据：官方 eval 流程已在类内逐条落地（脚本模板与 2.1.8 对齐），fail-closed
 *   路径齐备；真实可信度以**官方镜像上的 gold 对照**为准（判分链路可信闸，见
 *   benchmark/capability_swebench.mjs `--gold-control`），单元测试尚未覆盖（需镜像环境）。
 */
import { execFile, execFileSync } from 'node:child_process';

import { NativeTestRunner } from './nativeTestRunner.js';
import { PytestVerdict } from './pytestVerdict.js';
import type { ExecutorPort, VerifiedResult, VerifiedTask } from './swebenchVerified.js';

/** Docker 执行器配置。 */
export interface DockerExecutorOptions {
  /**
   * docker CLI 路径。
   * 缺省读环境变量 `OMNI_DOCKER_CLI`，再缺省 `docker`（依赖位置集中：显式参数 > 环境变量 > 约定名）。
   */
  readonly dockerCli?: string;
  /**
   * 镜像仓库前缀（受限网络下拉取用，按序尝试；成功后 `docker tag` 回官方名）。
   * 缺省读环境变量 `OMNI_DOCKER_MIRRORS`（逗号分隔），再缺省空 = 仅直连 Docker Hub。
   */
  readonly mirrorBases?: readonly string[];
  /** 单实例测试超时（ms）；缺省 1_800_000 = 官方 harness 的 30 分钟。 */
  readonly testTimeoutMs?: number;
}

/** 官方 pytest 类仓库的统一 test_cmd（SWE-bench 2.1.8 `constants.py` 的 `TEST_PYTEST` 原文）。 */
const OFFICIAL_PYTEST_CMD = 'pytest --no-header -rA --tb=no -p no:cacheprovider';

/**
 * 已登记官方 test_cmd 的仓库集合（官方 2.1.8 `MAP_REPO_VERSION_TO_SPECS` 中逐仓核实均为
 * `TEST_PYTEST`；django 走 runtests.py、sympy 走 bin/test，均不在本执行器范围）。
 */
const OFFICIAL_PYTEST_REPOS: ReadonlySet<string> = new Set<string>([
  'astropy/astropy',
  'matplotlib/matplotlib',
  'scikit-learn/scikit-learn',
  'pydata/xarray',
  'sphinx-doc/sphinx',
  'pytest-dev/pytest',
]);

/** 补丁 heredoc 分隔符（与官方 eval 脚本同一字符串，刻意生僻以避免与补丁正文冲突）。 */
const HEREDOC_DELIMITER = 'EOF_114329324912';

/** 容器内约定路径（与官方 `DOCKER_PATCH` / `DOCKER_WORKDIR` 常量一致）。 */
const WORKDIR = '/testbed';
const MODEL_PATCH_FILE = '/tmp/patch.diff';

/** 容器退出码协议：3=模型补丁应用失败（模型侧），4=官方测试补丁应用失败（环境侧）。 */
const EXIT_MODEL_PATCH_FAILED = 3;
const EXIT_TEST_PATCH_FAILED = 4;

/** 单次容器运行产物。 */
interface ContainerRun {
  /** 容器退出码（进程被杀或 docker 本身失败时为 -1）。 */
  readonly code: number;
  /** stdout 与 stderr 合并后的文本（解析与诊断的输入）。 */
  readonly output: string;
  /** 是否因超时被宿主终止。 */
  readonly timedOut: boolean;
}

/**
 * Docker 官方镜像执行器：官方预建镜像内应用补丁并跑官方 test_cmd，fail-closed 判定 resolved。
 */
export class DockerExecutor implements ExecutorPort {
  /** 后端种类标识（docker）。 */
  public readonly kind = 'docker' as const;

  /** docker CLI 路径。 */
  private readonly dockerCli: string;
  /** 镜像仓库前缀（拉取用，按序尝试）。 */
  private readonly mirrorBases: readonly string[];
  /** 单实例测试超时（ms）。 */
  private readonly testTimeoutMs: number;

  /**
   * 构造 Docker 执行器。
   * @param opts 配置（docker CLI 路径/镜像前缀/测试超时）。
   */
  public constructor(opts: Readonly<DockerExecutorOptions> = {}) {
    this.dockerCli = opts.dockerCli ?? process.env['OMNI_DOCKER_CLI'] ?? 'docker';
    this.mirrorBases =
      opts.mirrorBases ??
      (process.env['OMNI_DOCKER_MIRRORS'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    this.testTimeoutMs = opts.testTimeoutMs ?? 1_800_000;
  }

  /**
   * 配置摘要（调试用）。
   * @returns 形如 `docker(cli=..., mirrors=N, timeout=…s)` 的一行摘要。
   */
  public describe(): string {
    return `docker(cli=${this.dockerCli}, mirrors=${this.mirrorBases.length}, timeout=${Math.round(this.testTimeoutMs / 1000)}s)`;
  }

  /**
   * 运行单实例：官方镜像内应用 model/test 补丁 → 跑官方 test_cmd → 按 pytest 输出判定 resolved。
   * @param task 归一化任务（含 repo/base_commit/version/测试清单）。
   * @param modelPatch 模型生成的补丁（unified diff；空串视为无补丁，直接跑测试）。
   * @returns 单实例结果（fail-closed：设施缺失标 envError，模型补丁打不上记模型失败）。
   */
  public async run(task: VerifiedTask, modelPatch: string): Promise<VerifiedResult> {
    // fail-open 防线（与 NativeExecutor 同口径）：空 FAIL_TO_PASS 会使「全过=resolved」恒真。
    if (task.failToPass.length === 0) {
      return this.failEnv(task.id, 'FAIL_TO_PASS 为空 —— 拒绝判定（fail-open 假绿防线）');
    }
    if (!OFFICIAL_PYTEST_REPOS.has(task.repo)) {
      return this.failEnv(
        task.id,
        `仓库 ${task.repo} 未登记官方 test_cmd（DockerExecutor 只覆盖 pytest 类仓库），拒绝臆造命令`,
      );
    }
    if (!DockerExecutor.cliAvailable(this.dockerCli)) {
      return this.failEnv(
        task.id,
        `docker CLI 不可用（${this.dockerCli}）；可用 OMNI_DOCKER_CLI 指定绝对路径`,
      );
    }
    const image = this.officialImageRef(task.id);
    const pullError = await this.ensureImage(image);
    if (pullError !== null) {
      return this.failEnv(task.id, `官方镜像拉取失败: ${pullError}`);
    }
    const run = await this.runContainer(image, this.evalScriptOf(task, modelPatch));
    if (run.timedOut) {
      return this.failEnv(
        task.id,
        `测试超时（>${Math.round(this.testTimeoutMs / 1000)}s，官方 harness 同额 30min），容器已终止`,
      );
    }
    if (run.code === EXIT_MODEL_PATCH_FAILED) {
      return this.fail(task.id, 'model_patch 应用失败（模型补丁无法应用，视为未修复）');
    }
    if (run.code === EXIT_TEST_PATCH_FAILED) {
      return this.failEnv(task.id, 'test_patch 应用失败（官方测试补丁无法应用，未进入能力判定）');
    }
    const ids = [...task.failToPass, ...task.passToPass];
    const passed = PytestVerdict.parseResults(run.output, ids);
    const failToPassOk = task.failToPass.every((id) => passed.get(id) === true);
    const passToPassOk = task.passToPass.every((id) => passed.get(id) === true);
    if (failToPassOk && passToPassOk) {
      return { id: task.id, resolved: true, backend: this.kind };
    }
    const runInfo = { passed, diagnosis: NativeTestRunner.diagnose(run.output) };
    return {
      id: task.id,
      resolved: false,
      backend: this.kind,
      reason: NativeTestRunner.describeFailure(task.failToPass, task.passToPass, runInfo),
    };
  }

  /**
   * 官方预建镜像引用（2.1.8 命名规则：`__` → `_1776_`）。
   * @param instanceId 官方实例 id（如 `astropy__astropy-12907`）。
   * @returns 镜像引用（如 `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:v1`）。
   */
  private officialImageRef(instanceId: string): string {
    return `swebench/sweb.eval.x86_64.${instanceId.replace(/__/g, '_1776_')}:v1`;
  }

  /**
   * 确保镜像在本地：已有则直接返回；否则按「镜像前缀 → 直连」逐源拉取并 tag 回官方名。
   * @param image 官方镜像引用。
   * @returns 成功返回 null；全败返回含各源原因的一行诊断。
   */
  private async ensureImage(image: string): Promise<string | null> {
    if (DockerExecutor.imageExists(this.dockerCli, image)) return null;
    const sources = [...this.mirrorBases.map((m) => `${m}/${image}`), image];
    const failures: string[] = [];
    for (const src of sources) {
      const error = await DockerExecutor.pullImage(this.dockerCli, src);
      if (error !== null) {
        failures.push(`${src}: ${error}`);
        continue;
      }
      if (src !== image) {
        try {
          execFileSync(this.dockerCli, ['tag', src, image], { stdio: 'ignore' });
        } catch (error) {
          failures.push(`${src}: tag 失败 ${DockerExecutor.msg(error)}`);
          continue;
        }
      }
      return null;
    }
    return failures.join(' | ');
  }

  /**
   * 本地是否已有该镜像。
   * @param cli docker CLI 路径。
   * @param image 镜像引用。
   * @returns 存在返回 true。
   */
  private static imageExists(cli: string, image: string): boolean {
    try {
      execFileSync(cli, ['image', 'inspect', image], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 拉取镜像（stdout/stderr 不回捕：docker 进度条噪声大，只需成败）。
   * @param cli docker CLI 路径。
   * @param ref 待拉取引用（可为「镜像前缀/官方名」）。
   * @returns 成功返回 null；失败返回错误短消息。
   */
  private static async pullImage(cli: string, ref: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      execFile(cli, ['pull', ref], { timeout: 3_600_000, maxBuffer: 1024 * 1024 }, (err) => {
        resolve(err === null ? null : DockerExecutor.msg(err));
      });
    });
  }

  /**
   * 构造官方口径的 eval 脚本（与 2.1.8 `make_eval_script_list` 语义逐条对齐；
   * 省略官方仅作记录用的 `git status/show/diff` 信息段，避免噪声进入解析输入）。
   * @param task 归一化任务。
   * @param modelPatch 模型补丁（空串则跳过应用，与 native 的空补丁=无操作同口径）。
   * @returns 完整 bash 脚本文本。
   */
  private evalScriptOf(task: VerifiedTask, modelPatch: string): string {
    const allTestFiles = DockerExecutor.filesOfPatch(task.testPatch);
    const directives = PytestVerdict.testFilesOf(task.testPatch);
    const lines: string[] = [
      '#!/bin/bash',
      'set -uxo pipefail',
      'source /opt/miniconda3/bin/activate',
      'conda activate testbed',
      `cd ${WORKDIR}`,
      'git config --global --add safe.directory /testbed',
      ...DockerExecutor.modelPatchBlock(modelPatch),
      // 官方 reset 的对象是 test_patch 的**全部**文件（不只「测试样貌」文件），用于撤销模型
      // 补丁对测试文件的改动；为空时跳过——`git checkout <base>` 不带路径会切走 HEAD，不可执行。
      ...(allTestFiles.length > 0
        ? [`git checkout ${task.baseCommit} ${allTestFiles.join(' ')}`]
        : []),
      `git apply -v - <<'${HEREDOC_DELIMITER}'`,
      task.testPatch,
      HEREDOC_DELIMITER,
      'if [ $? -ne 0 ]; then echo "OMNI_TEST_PATCH_APPLY_FAILED"; exit 4; fi',
      [OFFICIAL_PYTEST_CMD, ...directives].join(' '),
    ];
    return `${lines.join('\n')}\n`;
  }

  /**
   * 模型补丁应用块（官方 run_instance 同口径：先 `git apply`，失败回退 `patch --fuzz=5`，
   * 仍失败即退出码 3 —— 空补丁跳过整块）。
   * @param modelPatch 模型补丁文本。
   * @returns 脚本行（空补丁为空数组）。
   */
  private static modelPatchBlock(modelPatch: string): readonly string[] {
    if (modelPatch.trim().length === 0) return [];
    return [
      `cat > ${MODEL_PATCH_FILE} <<'${HEREDOC_DELIMITER}'`,
      modelPatch,
      HEREDOC_DELIMITER,
      `git apply -v ${MODEL_PATCH_FILE}`,
      'if [ $? -ne 0 ]; then',
      `  patch --batch --fuzz=5 -p1 -i ${MODEL_PATCH_FILE}`,
      'fi',
      'if [ $? -ne 0 ]; then echo "OMNI_MODEL_PATCH_APPLY_FAILED"; exit 3; fi',
    ];
  }

  /**
   * 从 unified diff 提取**全部**被改动文件路径（`+++ b/<path>` 头；官方 reset 用全量，
   * directives 另由 {@link PytestVerdict.testFilesOf} 过滤出测试样貌文件）。
   * @param patch unified diff 文本。
   * @returns 路径列表（去重、保序）。
   */
  private static filesOfPatch(patch: string): readonly string[] {
    const files: string[] = [];
    for (const line of patch.split('\n')) {
      const m = /^\+\+\+ b\/(.+?)(?:\t.*)?$/.exec(line);
      const p = m?.[1]?.trim();
      if (p !== undefined && p !== '' && p !== '/dev/null' && !files.includes(p)) files.push(p);
    }
    return files;
  }

  /**
   * 运行容器：脚本经 stdin 送入 `bash -s`，合并回捕 stdout/stderr 作为测试日志。
   * @param image 镜像引用（官方名）。
   * @param script eval 脚本文本。
   * @returns 运行产物（退出码/合并输出/是否超时；docker 自身失败时 code=-1 并带诊断）。
   */
  private runContainer(image: string, script: string): Promise<ContainerRun> {
    return new Promise<ContainerRun>((resolve) => {
      execFile(
        this.dockerCli,
        ['run', '--rm', '-i', image, '/bin/bash', '-s'],
        { timeout: this.testTimeoutMs, maxBuffer: 128 * 1024 * 1024, input: script },
        (err, stdout, stderr) => {
          const output = `${stdout ?? ''}\n${stderr ?? ''}`;
          if (err === null) {
            resolve({ code: 0, output, timedOut: false });
            return;
          }
          const code = typeof err.code === 'number' ? err.code : -1;
          resolve({ code, output, timedOut: err.killed === true });
        },
      );
    });
  }

  /**
   * docker CLI 可用性检查（`docker version` 走通即可用，同时覆盖 daemon 连接）。
   * @param cli docker CLI 路径。
   * @returns 可用返回 true。
   */
  private static cliAvailable(cli: string): boolean {
    try {
      execFileSync(cli, ['version', '--format', '{{.Server.Version}}'], {
        stdio: 'ignore',
        timeout: 30_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 构造未通过结果（模型侧失败）。
   * @param instanceId 实例 id。
   * @param reason 原因。
   * @returns 未通过结果。
   */
  private fail(instanceId: string, reason: string): VerifiedResult {
    return { id: instanceId, resolved: false, backend: this.kind, reason };
  }

  /**
   * 构造环境失败结果（envError：设施缺失/超时，未进入能力判定，不计入分母）。
   * @param instanceId 实例 id。
   * @param reason 原因。
   * @returns 带 envError 的未通过结果。
   */
  private failEnv(instanceId: string, reason: string): VerifiedResult {
    return { id: instanceId, resolved: false, backend: this.kind, envError: true, reason };
  }

  /**
   * 把未知错误归一为可读字符串。
   * @param error 错误。
   * @returns 可读消息。
   */
  private static msg(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
      return String((error as { message?: unknown }).message ?? error);
    }
    return String(error);
  }
}
