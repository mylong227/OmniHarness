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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** 一次测试运行的判定结果（含诊断）。 */
export interface NativeTestRun {
  /** id → 是否通过（缺项视为未通过，fail-closed）。 */
  readonly passed: ReadonlyMap<string, boolean>;
  /** 失败诊断的**短**提示（空串表示输出里没看到明显的环境/口径异常）。 */
  readonly diagnosis: string;
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
   * @returns 逐 id 判定 + 短诊断。
   */
  public async runFor(
    task: VerifiedTask,
    worktree: string,
    ids: readonly string[],
  ): Promise<NativeTestRun> {
    const spec = RepoTestSpecs.for(task.repo);
    const run =
      spec !== null
        ? await this.runCommand(worktree, spec.argsOf(ids, { testPatch: task.testPatch }))
        : await this.runPytest(worktree, PytestVerdict.testFilesOf(task.testPatch), ids);
    const passed =
      spec !== null ? spec.parse(run.stdout, ids) : PytestVerdict.parseResults(run.stdout, ids);
    NativeTestRunner.dumpIfRequested(task.id, run.stdout);
    return { passed, diagnosis: NativeTestRunner.diagnose(run.stdout) };
  }

  /**
   * 按需把**合并后的原始测试输出**落盘（`OMNI_EVAL_DUMP_TEST_OUTPUT=<目录>`）。
   *
   * 为什么需要它（2026-09-26 实测）：`pytest-dev__pytest-5262` / `sphinx-doc__sphinx-8120` 的 gold
   * 判出「0/108、0/44」却**看不出原因**——短诊断只覆盖已知形态，未知形态仍要手工重建环境复现，
   * 一次排查十几分钟。落盘后直接读原始输出即可定位（默认**不写盘**，零行为变更）。
   * @param instanceId 实例 id（作为文件名）。
   * @param output 合并后的输出。
   * @returns 无。
   */
  private static dumpIfRequested(instanceId: string, output: string): void {
    const dir = process.env['OMNI_EVAL_DUMP_TEST_OUTPUT'];
    if (dir === undefined || dir === '') return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${instanceId}.log`), output, 'utf8');
    } catch {
      // 诊断落盘失败不得影响判定（best-effort）
    }
  }

  /**
   * 构造「测试未通过」的**可读原因**：F2P/P2P 通过计数 + 测试输出短诊断。
   *
   * 为什么必须带计数与诊断（2026-09-26 实测）：gold 对照跑出 26 个 `resolved=false` 而报告里
   * **没有任何原因**，于是「环境没装好」「测试选择口径不对」「真的没修好」三类混在一起不可分，
   * 判分可信度的调查只能靠手工复现。计数能立刻看出「F2P 全挂但 P2P 全过」（口径/环境）
   * 与「只有 F2P 挂」（真的没修好）的区别。
   *
   * 放在这里而不是执行器里：执行器已顶到「上帝类」红线（>25 方法），按纪律**把职责放到正确的类**，
   * 而不是删注释凑数。
   * @param failToPass 该实例的 FAIL_TO_PASS 清单。
   * @param passToPass 该实例的 PASS_TO_PASS 清单。
   * @param run 测试运行结果（含短诊断）。
   * @returns 人类可读原因。
   */
  public static describeFailure(
    failToPass: readonly string[],
    passToPass: readonly string[],
    run: NativeTestRun,
  ): string {
    const count = (ids: readonly string[]): number =>
      ids.filter((id) => run.passed.get(id) === true).length;
    const detail =
      `FAIL_TO_PASS ${count(failToPass)}/${failToPass.length}、` +
      `PASS_TO_PASS ${count(passToPass)}/${passToPass.length}`;
    const parts = [`测试未通过（${detail}）`];
    const sample = NativeTestRunner.failedSample([...failToPass, ...passToPass], run);
    if (sample !== '') parts.push(`未通过样例: ${sample}`);
    const artifact = NativeTestRunner.artifactIdNote([...failToPass, ...passToPass], run);
    if (artifact !== '') parts.push(artifact);
    if (run.diagnosis !== '') parts.push(run.diagnosis);
    return parts.join('；');
  }

  /**
   * 指出「未通过的 id 里有**官方解析器的换行产物 id**」——即根本不是测试的 id。
   *
   * 实证（2026-09-26，`pytest-dev__pytest-5262`）：其 PASS_TO_PASS 里含一个字面量 **`[100%]`**。
   * 那是官方 `parse_log_pytest` 在**终端换行**把 `-v` 行的百分比折到下一行时，把 `PASSED [100%]`
   * 单独成行后 `split()[1]` 取到的 token（上游源码注释亦承认「P2P for pytest-5262 / -7521 literally
   * expects `[100%]`」）。我们以钉住输出的方式跑（无 TTY 换行）⇒ 该行不出现 ⇒ 这一条永远对不上。
   *
   * 为什么要显式写出来：否则报告只显示「107/108 未通过」，读者会以为还差一个真实测试没修好。
   * @param ids FAIL_TO_PASS 与 PASS_TO_PASS 的合并清单。
   * @param run 测试运行结果。
   * @returns 说明短句；无此类 id 时为空串。
   */
  private static artifactIdNote(ids: readonly string[], run: NativeTestRun): string {
    const artifacts = ids.filter(
      (id) => run.passed.get(id) !== true && /^\[\s*\d+%\s*\]$/.test(id),
    );
    return artifacts.length === 0
      ? ''
      : `注意 ${artifacts.join(', ')} 是官方解析器的终端换行产物 id（非测试），本机无 TTY 换行不会产生该行`;
  }

  /**
   * 取最多 {@link NativeTestRunner.maxFailedSample} 个未通过 id 作为样例（截断到 60 字符）。
   *
   * 为什么要给 id 样例（2026-09-26 实测）：`django__django-11477` 的 gold 判出
   * 「FAIL_TO_PASS 3/3、PASS_TO_PASS 150/151」——计数说明只有一个 P2P 对不上，但**是哪一个**
   * 只能靠再跑一次并手工回捞。带上样例后，报告本身就能直接指向那一个 id。
   * @param ids FAIL_TO_PASS 与 PASS_TO_PASS 的合并清单（顺序即优先级：先报 F2P）。
   * @param run 测试运行结果。
   * @returns 逗号分隔的样例；全部通过时为空串。
   */
  private static failedSample(ids: readonly string[], run: NativeTestRun): string {
    const failed = ids.filter((id) => run.passed.get(id) !== true);
    return failed
      .slice(0, NativeTestRunner.maxFailedSample)
      .map((id) => (id.length > 60 ? `${id.slice(0, 60)}…` : id))
      .join(', ');
  }

  /** 原因里最多列出的未通过 id 个数（避免报告膨胀）。 */
  private static readonly maxFailedSample = 3;

  /**
   * 从测试输出里给出**短诊断**：区分「环境/依赖没装好」「测试选择口径不对」「测试真的失败」三类。
   *
   * 为什么必须有它（2026-09-26 实测）：旧实现只把失败记成 `resolved=false` 而**不带任何原因**，
   * 于是 gold 对照报告里 26 个未 resolved 的实例无法与「模型没修好」区分，也无从判断是环境、口径
   * 还是真的测试失败——判分可信度调查因此在报告层就断了线索。这里只回**短句**（明细截断），
   * 既不膨胀报告，又能把三类原因分流。
   * @param output 合并后的测试输出。
   * @returns 诊断短句；无异常时为空串。
   */
  public static diagnose(output: string): string {
    if (output.trim() === '') return '测试命令无任何输出（命令形态/流捕获可疑）';
    for (const [pattern, label] of NativeTestRunner.diagnosisPatterns) {
      const m = pattern.exec(output);
      if (m !== null) return `${label}：${(m[1] ?? m[0]).trim().slice(0, 160)}`;
    }
    return '';
  }

  /**
   * 诊断规则（按序匹配、命中即返回；正则第 1 组为明细行，缺省用整段匹配）。
   * 覆盖实测见过的四类：依赖未装齐、conftest 导入失败、测试选择口径不对（零收集）、命令无输出。
   */
  private static readonly diagnosisPatterns: readonly (readonly [RegExp, string])[] = [
    [/(?:^|\n)(ERROR collecting [^\n]+)/, '收集错误（疑似依赖未装齐/导入失败）'],
    [/(?:^|\n)(ImportError while loading conftest[^\n]*)/, 'conftest 导入失败（疑似依赖未装齐）'],
    [/(?:^|\n)(ModuleNotFoundError[^\n]*)/, '模块缺失（疑似依赖未装齐）'],
    [/(unittest\.loader\._FailedTest[^\n]*)/, '测试无法导入（directive/口径不对）'],
    [/(?:^|\n)(collected 0 items[^\n]*)/, '零收集（测试选择口径可疑）'],
    [/(?:^|\n)(no tests ran[^\n]*)/, '零执行（测试选择口径可疑）'],
    [/(?:^|\n)(SyntaxError[^\n]*)/, '语法错误（补丁或测试文件不可导入）'],
    // 通用兜底：**启动期崩溃**（第三方 pytest 插件与老版本不兼容、依赖主版本过新）会打出 Traceback
    // 而**不产出任何结果行**。实证现场：pytest 4.5 + 新版 setuptools 自带 typeguard 插件 ⇒ `AssertionError`；
    // sphinx 3.3 + jinja2 3.1 ⇒ `cannot import name 'environmentfilter'`。两者都曾被读成「模型没修好」。
    [
      /Traceback \(most recent call last\)[\s\S]{0,6000}?\n((?:\w+\.)*\w*(?:Error|Exception)[^\n]*)/,
      '测试运行崩溃（Python 异常，疑插件/依赖主版本冲突）',
    ],
  ];

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
   *
   * ⚠️ **必须同时收 stderr**（2026-09-26 实测修）：旧实现只取 `stdout`，而 pytest 的
   * **启动期崩溃/收集期致命错误几乎都写 stderr**（解释器不兼容、conftest 导入失败、插件缺失），
   * 于是输出被读成**空字符串** ⇒ 全部 id 判假 + 诊断为「测试命令无任何输出」。
   * 真实现场：`pytest-dev__pytest-5262`（pytest 4.5 在老解释器上启动即崩）与 `sphinx-doc__sphinx-8120`
   * 都恰好落在这一形态上——它们是**判分链路缺陷**，不是「模型没修好」。
   * @param worktree worktree 路径。
   * @param testFiles test_patch 改动的测试文件（可为空）。
   * @param ids 测试 id 列表（无测试文件时的直跑参数）。
   * @returns 合并后的输出与退出码。
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
      execFile(
        venvPython,
        args,
        { cwd: worktree, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err !== null && typeof err.code === 'number' ? err.code : 0;
          resolve({ stdout: `${stdout ?? ''}\n${stderr ?? ''}`, code });
        },
      );
    });
  }
}
