/**
 * 测试命令输出的**计数解析器**（2026-10-03 第五轮：补完成闸门的"零测试"漏洞）。
 *
 * ## 为什么需要它
 *
 * 完成闸门的原判据只有 `exitCode !== 0`（见 `turnEndCompletionGate.ts`），而
 * **"测试命令一条都没匹配到"在 Node 里是成功退出**：实测
 * `node --test "dist/tests/unit/__nonexistent__*.test.js"` 输出
 * `# tests 0 / # pass 0 / # fail 0` 且 **exit = 0**。于是"没跑任何测试"会被判成"验证通过"，
 * 正好落进本仓最忌讳的**假完成**形态（外部调研亦证实：假成功占单控制域失败轨迹的 45–48%）。
 * 主流工具刻意区分二者：pytest 把"没收集到测试"单列为 **exit 5**，Jest 需显式
 * `--passWithNoTests` 才允许空跑通过。
 *
 * ## 判据取向（**刻意不做过度 fail-closed**）
 *
 * - 只认**显式的零测试证据**（`# tests 0` / `collected 0 items` / `no tests ran` /
 *   `no test files` / `Tests:  0 total` / `No test files found`）——这是硬证据，必须拦；
 * - **拿不到汇总行**（输出被 `maxOutputBytes` 截断，或命令根本不是测试运行器，如 `tsc --noEmit`）
 *   ⇒ **不拦**。否则会把"日志被截断"与"静态检查天然没有测试计数"误判为失败
 *   ——三处边界里第一条写明闸门是**增强**，不是环境检测器。
 */

/** 识别出的测试运行器种类（决定报告里给哪种计数口径）。 */
export type TestRunnerKind = 'node-test' | 'jest' | 'pytest' | 'vitest' | 'go-test' | 'unknown';

/** 一次解析的结论（全部字段显式回传，不抛异常）。 */
export interface TestCountReport {
  /** 识别出的运行器（命令特征优先，输出特征兜底）。 */
  readonly runner: TestRunnerKind;
  /** 解析到的用例总数（解析不到为 0，**不等于**"确实零测试"——见 `zeroEvidence`）。 */
  readonly total: number;
  /** 解析到的通过数。 */
  readonly passed: number;
  /** 解析到的失败数。 */
  readonly failed: number;
  /**
   * 是否存在**显式的零测试证据**。
   * `true` ⇒ 完成闸门必须拦截收尾（"零测试 ≠ 通过"）。
   */
  readonly zeroEvidence: boolean;
}

/**
 * 把测试命令输出解析成计数报告（纯函数、无状态、无第三方依赖）。
 */
export class TestCountParser {
  /** 命令特征 → 运行器（顺序即优先级）。 */
  private static readonly COMMAND_PATTERNS: readonly (readonly [TestRunnerKind, RegExp])[] = [
    ['node-test', /(^|[\s&|;])node\b[^\n]*\s--test\b/],
    ['vitest', /(^|[\s&|;])(npx\s+)?vitest\b/],
    ['jest', /(^|[\s&|;])(npx\s+)?jest\b/],
    ['pytest', /(^|[\s&|;])(python[0-9.]*\s+-m\s+)?pytest\b/],
    ['go-test', /(^|[\s&|;])go\s+test\b/],
  ];

  /** 输出特征 → 运行器（命令看不出时兜底，如 `npm test`）。 */
  private static readonly OUTPUT_PATTERNS: readonly (readonly [TestRunnerKind, RegExp])[] = [
    ['node-test', /^#\s*tests\s+\d+/m],
    ['vitest', /^\s*Test Files\s+/m],
    ['jest', /^\s*Tests:\s+/m],
    ['pytest', /^=+\s.*\b(passed|failed|error)\b.*\s=+$/m],
  ];

  /** 显式"零测试"证据（任一命中即以零测试判定）。 */
  private static readonly ZERO_EVIDENCE: readonly RegExp[] = [
    /^#\s*tests\s+0\s*$/m, // node --test
    /\bcollected\s+0\s+items?\b/i, // pytest
    /\bno tests ran\b/i, // pytest
    /\bno test files?\b/i, // go test / vitest
    /\bNo test files found\b/i, // jest
    /^\s*Tests:\s+0\s+total\s*$/im, // jest
  ];

  /** node --test 汇总行：`# tests 12` / `# pass 11` / `# fail 1`。 */
  private static readonly NODE_TEST = {
    total: /^#\s*tests\s+(\d+)\s*$/m,
    passed: /^#\s*pass\s+(\d+)\s*$/m,
    failed: /^#\s*fail\s+(\d+)\s*$/m,
  } as const;

  /** jest 汇总行：`Tests:       1 failed, 2 passed, 3 total`。 */
  private static readonly JEST = {
    total: /^\s*Tests:\s+.*?(\d+)\s+total\s*$/m,
    passed: /^\s*Tests:\s+.*?(\d+)\s+passed/m,
    failed: /^\s*Tests:\s+.*?(\d+)\s+failed/m,
  } as const;

  /** vitest 汇总行：`Tests  2 failed | 3 passed (5)`。 */
  private static readonly VITEST = {
    total: /^\s*Tests\s+.*?\((\d+)\)\s*$/m,
    passed: /^\s*Tests\s+.*?(\d+)\s+passed/m,
    failed: /^\s*Tests\s+.*?(\d+)\s+failed/m,
  } as const;

  /** pytest 汇总行：`=== 3 passed, 1 failed in 0.12s ===`。 */
  private static readonly PYTEST = {
    passed: /(\d+)\s+passed/i,
    failed: /(\d+)\s+(failed|error)/i,
  } as const;

  /**
   * 从命令文本识别测试运行器。
   * @param command 验证命令文本。
   * @returns 识别出的运行器；识别不出为 `'unknown'`。
   */
  public static runnerOf(command: string): TestRunnerKind {
    for (const [kind, pattern] of TestCountParser.COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return kind;
      }
    }
    return 'unknown';
  }

  /**
   * 解析一次测试命令输出。
   * @param command 实际执行的命令文本（用于识别运行器）。
   * @param output 合并后的输出文本（stdout + stderr，可能已被上限截断）。
   * @returns 计数报告（永不抛错）。
   */
  public static parse(command: string, output: string): TestCountReport {
    // 先在**剔除用例名回显**的文本上判读（见 `evidenceTextOf`）：
    // node 的 TAP 会把每个用例名原样回显（`# Subtest: <名>` / `ok 1 - <名>`），
    // 而用例名里完全可能包含 `no tests ran` / `collected 0 items` 这类字样——
    // 实测本仓 `testCountParser.test.ts` 自己的用例名就命中了三条零测试正则，导致
    // 「9 个用例全过」被误判成「零测试」。仪器不得把被测对象的名字当成自己的读数。
    const evidence = TestCountParser.evidenceTextOf(output);
    const fromCommand = TestCountParser.runnerOf(command);
    const runner =
      fromCommand !== 'unknown' ? fromCommand : TestCountParser.runnerFromOutput(evidence);
    const zeroEvidence = TestCountParser.ZERO_EVIDENCE.some((pattern) => pattern.test(evidence));
    const counts = TestCountParser.countsOf(runner, evidence);
    return {
      runner,
      total: counts.total,
      passed: counts.passed,
      failed: counts.failed,
      zeroEvidence,
    };
  }

  /**
   * 生成"只含运行器自身读数"的文本：剔除逐用例行的**用例名回显**。
   *
   * 剔除的都是各运行器逐用例输出的固定形状，故不会误删汇总行：
   *  - node TAP：`# Subtest: <名>` 与 `ok N - <名>` / `not ok N - <名>`；
   *  - jest / vitest：`✓ <名>` / `✕ <名>`；
   *  - pytest：`PASSED <节点>` / `FAILED <节点>`。
   * @param output 合并后的输出文本。
   * @returns 逐行过滤后的文本（保留换行，正则的 `^`/`$`/`m` 语义不变）。
   */
  private static evidenceTextOf(output: string): string {
    return output
      .split('\n')
      .filter((line) => !TestCountParser.isCaseNameEcho(line.trim()))
      .join('\n');
  }

  /**
   * 该行是否是"逐用例输出里的用例名回显"（判定为回显即不参与读数）。
   * @param trimmed 已 trim 的单行文本。
   * @returns 是回显为 true。
   */
  private static isCaseNameEcho(trimmed: string): boolean {
    if (trimmed.startsWith('# Subtest:')) {
      return true;
    }
    if (/^(not )?ok \d+ - /.test(trimmed)) {
      return true;
    }
    if (/^[✓✕×]\s/.test(trimmed)) {
      return true;
    }
    return /^(PASSED|FAILED|ERROR)\s/.test(trimmed);
  }

  /**
   * 从输出特征兜底识别运行器（`npm test` 这类包装命令看不出真实运行器）。
   * @param output 合并后的输出文本。
   * @returns 识别出的运行器；识别不出为 `'unknown'`。
   */
  private static runnerFromOutput(output: string): TestRunnerKind {
    for (const [kind, pattern] of TestCountParser.OUTPUT_PATTERNS) {
      if (pattern.test(output)) {
        return kind;
      }
    }
    return 'unknown';
  }

  /**
   * 按运行器口径提取计数。
   * @param runner 运行器种类。
   * @param output 合并后的输出文本。
   * @returns `{ total, passed, failed }`（提取不到即为 0）。
   */
  private static countsOf(
    runner: TestRunnerKind,
    output: string,
  ): { readonly total: number; readonly passed: number; readonly failed: number } {
    if (runner === 'node-test') {
      return {
        total: TestCountParser.numberOf(TestCountParser.NODE_TEST.total, output),
        passed: TestCountParser.numberOf(TestCountParser.NODE_TEST.passed, output),
        failed: TestCountParser.numberOf(TestCountParser.NODE_TEST.failed, output),
      };
    }
    if (runner === 'jest') {
      return {
        total: TestCountParser.numberOf(TestCountParser.JEST.total, output),
        passed: TestCountParser.numberOf(TestCountParser.JEST.passed, output),
        failed: TestCountParser.numberOf(TestCountParser.JEST.failed, output),
      };
    }
    if (runner === 'vitest') {
      return {
        total: TestCountParser.numberOf(TestCountParser.VITEST.total, output),
        passed: TestCountParser.numberOf(TestCountParser.VITEST.passed, output),
        failed: TestCountParser.numberOf(TestCountParser.VITEST.failed, output),
      };
    }
    if (runner === 'pytest') {
      const passed = TestCountParser.numberOf(TestCountParser.PYTEST.passed, output);
      const failed = TestCountParser.numberOf(TestCountParser.PYTEST.failed, output);
      return { total: passed + failed, passed, failed };
    }
    // go-test 与 unknown：不臆造计数（go 的 `ok pkg` 只说包通过，不说用例数）。
    return { total: 0, passed: 0, failed: 0 };
  }

  /**
   * 取第一个捕获组的整数。
   * @param pattern 带捕获组的正则。
   * @param text 待匹配文本。
   * @returns 解析到的整数；未命中或非数为 0。
   */
  private static numberOf(pattern: RegExp, text: string): number {
    const matched = pattern.exec(text);
    const raw = matched?.[1];
    if (raw === undefined) {
      return 0;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
}
