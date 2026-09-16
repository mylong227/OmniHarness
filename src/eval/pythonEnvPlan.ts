/**
 * Python 测试环境**依赖安装阶梯**的纯规划器（不含任何 I/O）。
 *
 * 定位：把「在 worktree 内如何一步步安装依赖」这一策略从 {@link NativeExecutor} 中抽离为**可单测的纯函数**。
 * 因为安装**顺序本身是核心不变量**——升序即优先级，后步修正前步的过宽解析；其中最后一步
 * 「仅在 pytest 缺失时安装」正是修复下述真实缺陷的关键，而真实 uv 安装无法在单测中执行。
 *
 * 真实现场（2026-09-17）：旧实现无条件 `uv pip install pytest pytest-timeout`，把 registry 最新
 * （pytest 9.x）装上，**顶掉**仓库自述 pinned 的 pytest 7.2.2；而 pytest 9 移除了 `monkeypatch.notset`
 * ⇒ flask 等老测试套件在 conftest 阶段即 60/60 全量 ERROR。故阶梯刻意后置且**先判存在**。
 *
 * @maturity L2 — 判据：阶梯顺序/覆盖语义（extras → 已 pinned 测试依赖 → 额外约束 → 仅在缺失时装 pytest）
 *   由 tests/unit/pythonEnvPlan.test.ts 覆盖；端到端有效性由 evals/e2e-native-gitee-smoke.mjs 第二关
 *   （官方 gold patch 须判 resolved）覆盖。
 * @maturityEvidence tests/unit/pythonEnvPlan.test.ts
 */

/** 安装阶梯的一步（标签用于日志/诊断，args 直喂 `uv pip install`）。 */
export interface EnvInstallStep {
  /** 人类可读标签（日志/诊断）。 */
  readonly label: string;
  /** `uv pip install` 的参数列表（如 `['-e', '.']`、`['-r', 'requirements/tests.txt']`）。 */
  readonly args: readonly string[];
}

/** 阶梯规划输入。 */
export interface EnvPlanInput {
  /** worktree 内首个存在的**已 pinned** 测试依赖文件（相对路径）；无则 undefined。 */
  readonly requirementsFile?: string | undefined;
  /** 该仓库的额外 pip 约束（如 `['Werkzeug<3']`）；无则空数组。 */
  readonly pins: readonly string[];
  /** venv 内 pytest 是否已可导入（决定是否需兜底安装）。 */
  readonly pytestPresent: boolean;
}

/** Python 测试环境依赖安装阶梯规划器。 */
export class PythonEnvPlan {
  /** 依次尝试安装的可选 extras（项目未声明者会被 uv 优雅忽略，故可安全逐一尝试）。 */
  public static readonly testExtras: readonly string[] = ['test', 'tests'];

  /**
   * **已 pinned** 测试依赖文件候选（按优先级，取首个存在者）。
   * 用途：确定 pytest 等测试设施的真实版本，避免被 registry-latest 覆盖。
   * 例：flask ⇒ `requirements/tests.txt`（pytest==7.2.2）；django ⇒ `tests/requirements/py3.txt`。
   */
  public static readonly testRequirementFiles: readonly string[] = [
    'requirements/tests.txt',
    'requirements/test.txt',
    'tests/requirements/py3.txt',
    'test-requirements.txt',
    'requirements-dev.txt',
    'requirements/dev.txt',
    'dev-requirements.txt',
  ];

  /**
   * 选出首个存在的已 pinned 测试依赖文件。
   * @param exists 存在性判定（相对 worktree 的路径 → 是否存在）；由调用方注入以隔离文件系统。
   * @returns 命中的相对路径；均不存在则 undefined。
   */
  public static findTestRequirements(exists: (rel: string) => boolean): string | undefined {
    return PythonEnvPlan.testRequirementFiles.find((rel) => exists(rel));
  }

  /**
   * 生成安装阶梯（数组顺序即执行顺序，后步可修正前步的过宽解析）。
   *
   * 顺序：① 仓库本体 `-e .` → ② 可选 extras `.[test]`/`.[tests]` → ③ 仓库已 pinned 测试依赖文件 →
   * ④ 该仓库额外约束 → ⑤ **仅在 pytest 缺失时**兜底装 pytest。
   * @param input 规划输入。
   * @returns 有序步骤列表。
   */
  public static steps(input: EnvPlanInput): readonly EnvInstallStep[] {
    const steps: EnvInstallStep[] = [
      { label: '仓库本体（含其声明的运行时依赖）', args: ['-e', '.'] },
    ];
    for (const extra of PythonEnvPlan.testExtras) {
      steps.push({ label: `可选 extras [${extra}]`, args: ['-e', `.[${extra}]`] });
    }
    if (input.requirementsFile !== undefined) {
      steps.push({
        label: `仓库已 pinned 测试依赖（${input.requirementsFile}）`,
        args: ['-r', input.requirementsFile],
      });
    }
    if (input.pins.length > 0) {
      steps.push({ label: '仓库额外约束（修复不设上界的开发期依赖）', args: [...input.pins] });
    }
    if (!input.pytestPresent) {
      steps.push({ label: '兜底安装 pytest（仅在缺失时，绝不覆盖仓库 pin）', args: ['pytest'] });
    }
    return steps;
  }
}
