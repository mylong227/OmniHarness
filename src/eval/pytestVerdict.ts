/**
 * pytest 判定纯解析器：把 pytest 标准输出与官方测试补丁解析成「逐测试是否通过」。
 *
 * 抽成独立类的理由：判定口径本身有两处易错点（输出形态、id 形态），集中一处便于单测钉死；
 * 同时让 {@link NativeExecutor} 保持单一职责（执行），不再承担解析。
 *
 * 两类兼容：
 * - **输出形态**：`-v` 的 `<nodeid> PASSED [ 12%]`，与 `-rA` 的 `PASSED <nodeid>`。
 * - **id 形态**：官方数据集有的仓库给**完整 nodeid**（`tests/test_x.py::test_a`），有的给**裸测试名**
 *   （`test_create_expand_pow_optimization`，sympy/django 等）。裸名直接当 pytest 参数会被当作路径
 *   ⇒ `collected 0 items` ⇒ 判定恒假（实测连 gold 都判不过），故一律按**叶子名**比对。
 *
 * 零 IO、零依赖。
 */
export class PytestVerdict {
  /**
   * 从 pytest 输出解析各测试 id 的通过情况。
   * @param output pytest 标准输出。
   * @param ids 待判定的测试 id 列表（FAIL_TO_PASS ∪ PASS_TO_PASS）。
   * @returns id → 是否通过（未出现/非 PASSED 一律 false，fail-closed）。
   */
  public static parseResults(output: string, ids: readonly string[]): ReadonlyMap<string, boolean> {
    const full = new Set<string>();
    const leaf = new Set<string>();
    for (const raw of output.split('\n')) {
      const line = raw.trim();
      // 形态 B（-rA 摘要）：`PASSED <nodeid>` / `FAILED <nodeid> - msg`。
      let m: RegExpExecArray | null = /^(?<st>PASSED|FAILED|ERROR|SKIPPED)\s+(?<id>\S+)/.exec(line);
      if (m === null) {
        // 形态 A（-v 明细）：`<nodeid> PASSED   [ 12%]`。
        m = /^(?<id>\S+)\s+(?<st>PASSED|FAILED|ERROR|SKIPPED)\b/.exec(line);
      }
      const g = m?.groups;
      if (g === undefined || g['st'] !== 'PASSED') continue;
      const hit = g['id'] ?? '';
      full.add(hit);
      leaf.add(PytestVerdict.leafName(hit));
    }
    const results = new Map<string, boolean>();
    for (const id of ids) {
      results.set(id, full.has(id) || leaf.has(PytestVerdict.leafName(id)));
    }
    return results;
  }

  /**
   * 从官方 `test_patch` 中解析出它**改动的测试文件**列表（`+++ b/<path>` 头）。
   *
   * 为什么需要：官方 harness 的判定口径是「跑 test_patch 改动的测试文件，再按名字比对结果」。
   * 直接把 FAIL_TO_PASS 名字当 pytest 参数只对「给完整 nodeid」的仓库成立；对 sympy/django 等
   * **给裸测试名**的仓库会被 pytest 当作不存在的路径 ⇒ `collected 0 items` ⇒ 判定恒假。
   * 只保留形似测试的文件（`tests/`、`testing/` 目录，或 `test_*.py` / `*_test.py`），
   * 以免把 `conftest.py` 之类当测试文件跑。
   * @param testPatch 官方测试补丁文本。
   * @returns 去重后的测试文件相对路径列表（解析不出时为空数组，调用方退回按 id 直跑）。
   */
  public static testFilesOf(testPatch: string): readonly string[] {
    const files = new Set<string>();
    const looksLikeTest = (p: string): boolean =>
      /(^|\/)(tests?|testing)\//.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p);
    for (const line of testPatch.split('\n')) {
      const m = /^\+\+\+ b\/(.+?)(?:\t.*)?$/.exec(line);
      const p = m?.[1]?.trim();
      if (p !== undefined && p !== '' && p !== '/dev/null' && looksLikeTest(p)) files.add(p);
    }
    return [...files];
  }

  /**
   * 取测试 id 的叶子名（最后一个 `::` 之后；无 `::` 则原样返回）。
   * @param id 完整 nodeid 或裸测试名。
   * @returns 叶子名（含参数化后缀 `[...]`）。
   */
  private static leafName(id: string): string {
    const i = id.lastIndexOf('::');
    return i === -1 ? id : id.slice(i + 2);
  }
}
