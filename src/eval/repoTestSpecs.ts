/**
 * 官方 **per-repo 测试命令 + 结果解析**（对齐 SWE-bench harness 的 `MAP_REPO_VERSION_TO_SPECS`）。
 *
 * ## 为什么必须有它（2026-09-26 实证，看板 §21.17）
 *
 * `capability_swebench --gold-control` 实测：Verified-30 上**只有 4/30 的官方 gold 补丁判 resolved**
 * （全是 sympy），其余 26 题（django 14 / astropy 2 / matplotlib 2 / xarray 2 / pytest 1 /
 * scikit-learn 2 / sphinx 3）gold 一律判不过 ⇒ 那 26 题的「模型失败」不含能力信息，
 * 整个子集的 resolved 率不可解读。
 *
 * 根因之一就是本文件要修的：判分主链路此前对**所有仓库**统一用
 * `python -m pytest <test_patch 里的测试文件> -rA`，而官方 harness 对每个仓库有**专属 test_cmd
 * 与专属日志解析器**。以 django 为例：官方是
 * `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 <dotted directives>`
 * （unittest 风格，结果行形如 `test_x (module.Class) ... ok`，且**输出走 stderr**），
 * 用通用 pytest 调用既选不出测试、也解析不出结果 ⇒ 恒判「未通过」。
 *
 * 设计：**注册表 + 纯函数**（无 IO、可单测），未登记的仓库返回 `null` ⇒ 调用方保持既有 pytest 路径
 * （零行为变更），只在有实证的仓库上启用专属命令。
 */

/** 规格执行上下文（`argsOf` 需要 test_patch 才能推出「跑哪些测试模块」）。 */
export interface RepoTestContext {
  /** 官方 test_patch（unified diff）。 */
  readonly testPatch: string;
}

/** 单仓库的测试执行规格。 */
export interface RepoTestSpec {
  /** 人类可读标签（用于日志/报告）。 */
  readonly label: string;
  /**
   * 构造**解释器之后**的参数列表（调用方负责用 venv 的 python 执行）。
   * @param ids 该实例的测试 id 列表（FAIL_TO_PASS + PASS_TO_PASS）。
   * @param ctx 执行上下文（含 test_patch）。
   * @returns 参数数组。
   */
  readonly argsOf: (ids: readonly string[], ctx: RepoTestContext) => readonly string[];
  /**
   * 解析测试输出 → 每个 id 是否通过。
   * @param output 标准输出与标准错误合并后的文本。
   * @param ids 该实例的测试 id 列表。
   * @returns id → 是否通过（缺项视为未通过，fail-closed）。
   */
  readonly parse: (output: string, ids: readonly string[]) => Map<string, boolean>;
}

/**
 * per-repo 测试规格注册表（未登记 / 未开启 ⇒ 返回 null，调用方回落通用 pytest 路径）。
 */
export class RepoTestSpecs {
  /**
   * 取某仓库的专属测试规格。
   *
   * ⚠️ **默认关闭、须先通过 gold 对照才可翻默认**（本仓「两关」纪律）：django 专属路径已实现且单测覆盖，
   * 但 2026-09-26 实测**尚未让 gold 判过**（标签/输出形态还有三层未收口，见看板 §21.18），
   * 故置于 `OMNI_REPO_TEST_SPECS=1` 之后；未开启时返回 `null` ⇒ 走既有 pytest 路径（零行为变更）。
   * @param repo 仓库 slug（如 `django/django`）。
   * @returns 规格；未登记 / 未开启 / 尚无实证时返回 `null`。
   */
  public static for(repo: string): RepoTestSpec | null {
    if (process.env.OMNI_REPO_TEST_SPECS !== '1') return null;
    if (repo === 'django/django') return RepoTestSpecs.django();
    return null;
  }

  /**
   * django 专属规格（官方 test_cmd + unittest 风格解析）。
   * @returns 规格对象。
   */
  public static django(): RepoTestSpec {
    return {
      label: 'django: ./tests/runtests.py --settings=test_sqlite',
      argsOf: (ids, ctx) => {
        // **关键（2026-09-26 实测，第二版踩中）**：不能把数据集里的 id 原样（或转成 `类.展示名`）当 directive——
        // unittest 用 docstring 当展示名，`Semicolons and commas are decoded (...)` 会被 runtests.py 当**模块名**
        // 导入 ⇒ `ModuleNotFoundError`（实测 8/65 行 ERROR）。官方 harness 的做法是**按 test_patch 推出要跑的
        // 测试模块**（`tests/httpwrappers/tests.py` → `httpwrappers.tests`），再用日志解析器把 F2P/P2P 挑回来。
        const modules = RepoTestSpecs.djangoModuleDirectivesOf(ctx.testPatch);
        const directives =
          modules.length > 0 ? modules : ids.map((id) => RepoTestSpecs.djangoDirectiveOf(id));
        return [
          './tests/runtests.py',
          '--verbosity',
          '2',
          '--settings=test_sqlite',
          '--parallel',
          '1',
          ...directives,
        ];
      },
      parse: (output, ids) => RepoTestSpecs.parseDjango(output, ids),
    };
  }

  /**
   * 从 test_patch 推出 django 的**测试模块 directive**（`tests/a/b.py` → `a.b`）。
   * @param testPatch 官方 test_patch（unified diff）。
   * @returns 去重后的模块 directive 数组（保持出现顺序）。
   */
  public static djangoModuleDirectivesOf(testPatch: string): string[] {
    const out: string[] = [];
    for (const m of testPatch.matchAll(/^diff --git a\/(.+?\.py)/gm)) {
      const file = m[1] ?? '';
      if (!file.startsWith('tests/')) continue;
      const label = file.slice('tests/'.length).replace(/\.py$/, '').replace(/\//g, '.');
      if (label !== '' && !out.includes(label)) out.push(label);
    }
    return out;
  }

  /**
   * 把官方数据集里的 django 测试 id 转成 `runtests.py` 认的**点分 directive**。
   *
   * 数据集形态（实测）：`test_memoryview_content (httpwrappers.tests.HttpResponseTests)`
   * ⇒ directive = `httpwrappers.tests.HttpResponseTests.test_memoryview_content`。
   *
   * **关键坑（2026-09-26 实测，首版踩中）**：unittest 的展示名默认取 **docstring**，于是 id 会是
   * `Semicolons and commas are decoded (httpwrappers.tests.QueryDictTests)`——展示名含空格、不是合法
   * Python 标识符，按 `类.展示名` 拼出的 directive **无法导入**（实测 65 个 id 里 35 个
   * `unittest.loader._FailedTest`）。此时退到**类级** directive（`module.Class`），该类全部测试都会被跑到，
   * 再由解析器按「展示名 id 原文」把结果挑回来。
   * @param testId 数据集口径的测试 id。
   * @returns 点分 directive（可能是类级）。
   */
  public static djangoDirectiveOf(testId: string): string {
    const id = testId.trim();
    // 展示名**可能是多词**（unittest 用 docstring 当展示名）⇒ 必须用 `(.*?)` 而非 `(\S+)`，
    // 否则多词 id 匹配失败会被整串原样透传（实测：35 个 docstring 测试因此没被跑到）。
    const m = /^(.*?)\s+\(([^)]+)\)$/.exec(id);
    if (m === null) return id; // 已是点分形式（或不可识别）时原样透传
    const method = (m[1] ?? '').trim();
    const target = (m[2] ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) return target; // 展示名非标识符 ⇒ 类级
    if (target.endsWith(`.${method}`)) return target; // 括号内已含方法名
    return `${target}.${method}`;
  }

  /**
   * 解析 django `runtests.py --verbosity 2` 的输出。
   *
   * 结果行形态（unittest TextTestRunner，**stderr 与 stdout 都可能出现**，故调用方须合并两路）：
   * `test_memoryview_content (httpwrappers.tests.HttpResponseTests) ... ok`
   * 判定：`ok` ⇒ 通过；`FAIL` / `ERROR` / `skipped…` / 未出现 ⇒ 未通过（与 pytest 路径同口径，fail-closed）。
   *
   * 索引方式：同时以「**展示名 id 原文**（`名 (类)`）」与「点分 directive」两种键登记，
   * 于是 docstring 展示名（类级 directive）与普通方法名两类 id 都能对上。
   * @param output 合并后的输出文本。
   * @param ids 数据集口径的测试 id 列表。
   * @returns id → 是否通过。
   */
  public static parseDjango(output: string, ids: readonly string[]): Map<string, boolean> {
    const status = new Map<string, boolean>();
    for (const raw of output.split('\n')) {
      const line = raw.trim();
      const m = /^(\S.*?)\s+\(([^)]+)\)(?:\s*\.\.\.)?\s*(ok|FAIL|ERROR|skipped.*)$/.exec(line);
      if (m === null) continue;
      const display = m[1] ?? '';
      const target = (m[2] ?? '').trim();
      const ok = (m[3] ?? '') === 'ok';
      // ① 展示名 id 原文（docstring 展示名走这条）② 点分 directive（普通方法名走这条）。
      status.set(`${display} (${target})`, ok);
      status.set(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(display) && !target.endsWith(`.${display}`)
          ? `${target}.${display}`
          : target,
        ok,
      );
    }
    const out = new Map<string, boolean>();
    for (const id of ids) {
      const key = id.trim();
      const hit = status.get(key) ?? status.get(RepoTestSpecs.djangoDirectiveOf(key));
      out.set(id, hit === true);
    }
    return out;
  }
}
