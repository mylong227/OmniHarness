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
 * per-repo 测试规格注册表（未登记仓库 ⇒ 返回 null，调用方回落通用 pytest 路径）。
 */
export class RepoTestSpecs {
  /**
   * 取某仓库的专属测试规格。
   *
   * **默认启用**（2026-09-26 翻默认）：翻默认的判据是「两关」齐过——`--gold-control` 在
   * **django 14 题上 14/14 判 resolved**（`eval-data/gold_control_django14.json`），
   * 且解析器对真实输出 65/65、154/154 全命中。此前默认关闭的理由（gold 判不过）已消除。
   *
   * 逃生口：`OMNI_REPO_TEST_SPECS=0` 强制回落既有 pytest 路径（用于对照实验/排障）。
   * @param repo 仓库 slug（如 `django/django`）。
   * @returns 规格；未登记仓库返回 `null`（走既有 pytest 路径）。
   */
  public static for(repo: string): RepoTestSpec | null {
    if (process.env['OMNI_REPO_TEST_SPECS'] === '0') return null;
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
      argsOf: (_ids, ctx) => {
        // **关键（2026-09-26 实测）**：不能把数据集里的 id 原样（或转成 `类.展示名`）当 directive——
        // unittest 用 docstring 当展示名，`Semicolons and commas are decoded (...)` 会被 runtests.py 当**模块名**
        // 导入 ⇒ `ModuleNotFoundError`（实测 8/65 行 ERROR）。官方 harness 的做法（`get_test_directives` 对
        // django 把 `tests/a/b.py` 转成 `a.b`）是**按 test_patch 推出要跑的测试模块**，再用日志解析器把
        // F2P/P2P 挑回来——本实现与之一致。
        //
        // 实测（django__django-11133，2026-09-26 复现）：模块 label `httpwrappers.tests` 与 app label
        // `httpwrappers` 均能跑出全部 65 个测试（`Ran 65 tests ... OK`）。此前记为「模块 label 跑出 0 条结果行」
        // 是**测量假象**：django 把测试结果写 stderr、把 `Testing against Django installed in ...` 等写 stdout，
        // 两路合并后**顺序交错**（头部可能出现在结果之后），只看单路或截断读缓冲就会读成「零结果」。
        const modules = RepoTestSpecs.djangoModuleDirectivesOf(ctx.testPatch);
        // test_patch 推不出 .py 模块时（实测 django-10097：只改 `tests/validators/*.txt` 数据文件）
        // **不能**把全部 id 转 directive 兜底：F2P+P2P 可达十万字符级 argv ⇒ Windows `spawn
        // ENAMETOOLONG`（2026-09-26 实测，还被归成模型失败）。官方 harness 的 directive 同样只来自
        // test_patch ⇒ 此时正解是**全量套件**（runtests.py 无 label 参数，argv 恒有界），
        // 由解析器从全量日志把 F2P/P2P id 挑回来。
        const directives = modules;
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
   * 结果行有**两种形态**（同一份输出里混用；unittest 开 `descriptions` 时 `getDescription()` 会返回
   * `str(test)\n<docstring 首行>`，于是状态落到第二行）：
   *
   * - 单行（无 docstring）：`test_not_modified (httpwrappers.tests.HttpResponseSubclassesTests) ... ok`
   * - 双行（有 docstring）：第一行 `test_invalid_redirect_repr (httpwrappers.tests.HttpResponseSubclassesTests)`
   *   第二行 `If HttpResponseRedirect raises DisallowedRedirect, its __repr__() ... ok`
   *
   * 数据集里的 id 正是这两种形态：**带括号**的是无 docstring 测试（`test_x (模块.类)`），
   * **不带括号**的是 docstring 展示名（如 `Semicolons and commas are decoded.`、
   * `#13572 - QueryDict with a non-default encoding`）——实测 django__django-11133 的 65 个 id 里 **8 个**，
   * 全 django 集 F2P 的 1058 个 id 里 **64 个**（F2P+P2P 20305 个里 3663 个）。
   * 故索引必须**同时登记**两种键，否则那批「裸展示名」id 永远对不上 ⇒ 被 fail-closed 判未通过。
   *
   * ⚠️ 已知边界：docstring 展示名可能跨类重复，此时裸展示名键是**歧义的**（数据集本身如此，
   * 官方 harness 同样无从区分），本实现取**后出现者**；带括号的 id 不受影响。
   * @param output 标准输出与标准错误合并后的文本。
   * @param ids 数据集口径的测试 id 列表。
   * @returns id → 是否通过（缺项视为未通过，fail-closed）。
   */
  public static parseDjango(output: string, ids: readonly string[]): Map<string, boolean> {
    const status = RepoTestSpecs.indexDjangoResults(output);
    const out = new Map<string, boolean>();
    for (const id of ids) {
      const key = RepoTestSpecs.normalizeSpace(id);
      const directive = RepoTestSpecs.normalizeSpace(RepoTestSpecs.djangoDirectiveOf(key));
      const hit = status.get(key) ?? status.get(directive);
      out.set(id, hit === true);
    }
    return out;
  }

  /**
   * 把 unittest 结果行索引成「多种键形态 → 是否通过」。
   * @param output 合并后的输出文本。
   * @returns 键 → 是否通过（键含 `展示名 (模块.类)`、裸展示名、点分 directive 三种形态）。
   */
  private static indexDjangoResults(output: string): Map<string, boolean> {
    const status = new Map<string, boolean>();
    let pending: { display: string; target: string } | null = null;
    for (const raw of output.split('\n')) {
      const line = raw.trim();
      const split = line === '' ? null : RepoTestSpecs.splitStatus(line);
      if (split === null) {
        pending = RepoTestSpecs.displayTargetOf(line);
        continue;
      }
      const inline = RepoTestSpecs.displayTargetOf(split.head);
      if (inline !== null) {
        RepoTestSpecs.indexInlineResult(status, inline, split.ok);
      } else {
        // 双行形态：`split.head` 是 docstring 展示名，与上一行的「测试 id + 类」配对。
        status.set(RepoTestSpecs.normalizeSpace(split.head), split.ok);
        if (pending !== null) status.set(`${pending.display} (${pending.target})`, split.ok);
      }
      pending = null;
    }
    return status;
  }

  /**
   * 登记**单行形态**的结果（`test_x (模块.类) ... ok`）。
   * @param status 结果索引（原地写入）。
   * @param inline 解析出的展示名与类路径。
   * @param ok 是否通过。
   * @returns 无（原地写入 `status`）。
   */
  private static indexInlineResult(
    status: Map<string, boolean>,
    inline: { display: string; target: string },
    ok: boolean,
  ): void {
    status.set(`${inline.display} (${inline.target})`, ok);
    if (!RepoTestSpecs.isIdentifier(inline.display)) return;
    status.set(
      inline.target.endsWith(`.${inline.display}`)
        ? inline.target
        : `${inline.target}.${inline.display}`,
      ok,
    );
  }

  /**
   * 把一行切成「描述 + 状态」。
   *
   * 用**最后一个** ` ... ` 分隔（docstring 自身可能含 ` ... `），并要求右侧确实是 unittest 状态词，
   * 否则判定该行不是结果行（返回 null ⇒ 当作双行形态的候选首行）。
   * @param line 去首尾空白后的行文本。
   * @returns `{ head, ok }`；非结果行返回 null。
   */
  private static splitStatus(line: string): { head: string; ok: boolean } | null {
    const idx = line.lastIndexOf(RepoTestSpecs.statusSeparator);
    if (idx < 0) return null;
    const tail = line.slice(idx + RepoTestSpecs.statusSeparator.length).trim();
    if (!RepoTestSpecs.statusWord.test(tail)) return null;
    return { head: line.slice(0, idx).trim(), ok: tail === 'ok' };
  }

  /**
   * 解析 `展示名 (模块.类)` 形态——即 unittest 的 `str(test)`。
   *
   * 两道闸缺一不可（都是实测踩出来的）：
   *
   * - **展示名必须是合法 Python 标识符**：否则 `System check identified no issues (0 silenced).`
   *   这类头部行会被当成「测试 id」（合并 stdout/stderr 后头部行可能紧邻结果行）。
   * - **括号内必须是点分标识符路径**（`模块.类[.方法]`）：否则**以括号短语结尾的 docstring** 会被误判。
   *   实测现场（`django__django-11477`，gold 因此判 150/151）：docstring 行
   *   `Namespace defaults to app_name when including a (pattern, app_name) ... ok`
   *   末尾正好是括号短语 ⇒ 旧实现把它当成「`展示名 (类)`」的行内结果行，
   *   **丢弃了上一行的待配对测试 id** ⇒ `test_app_object_default_namespace (…)` 永远拿不到状态、fail-closed 判假。
   * @param text 行或描述片段。
   * @returns `{ display, target }`；不匹配返回 null。
   */
  private static displayTargetOf(text: string): { display: string; target: string } | null {
    const m = /^(.+?)\s+\(([^)]+)\)$/.exec(text.trim());
    if (m === null) return null;
    const display = RepoTestSpecs.normalizeSpace(m[1] ?? '');
    const target = RepoTestSpecs.normalizeSpace(m[2] ?? '');
    if (!RepoTestSpecs.isIdentifier(display)) return null;
    if (!RepoTestSpecs.dottedPath.test(target)) return null;
    return { display, target };
  }

  /**
   * unittest `str(test)` 括号内的类路径形态：`模块[.子模块].类[.方法]`（至少一个点）。
   * 用点分标识符路径把「类路径」和「docstring 里的括号短语」区分开。
   */
  private static readonly dottedPath = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

  /** unittest 状态分隔符。 */
  private static readonly statusSeparator = ' ... ';

  /**
   * unittest 结果行的状态词（`ok` 之外一律不算通过）。
   * 覆盖：`FAIL` / `ERROR` / `skipped '...'` / `expected failure` / `unexpected success`。
   */
  private static readonly statusWord =
    /^(ok|FAIL|ERROR|skipped\b|expected failure|unexpected success)/;

  /**
   * 折叠连续空白（展示名可能含多空格/换行折叠差异）。
   * @param text 原文本。
   * @returns 折叠后的文本。
   */
  private static normalizeSpace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * 是否为合法 Python 标识符（决定能否拼成 `类.方法` directive）。
   * @param text 待判定文本。
   * @returns 合法返回 true。
   */
  private static isIdentifier(text: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
  }
}
