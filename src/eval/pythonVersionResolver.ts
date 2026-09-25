/**
 * SWE-bench 实例所需 Python 版本解析（纯函数，零 IO、零依赖）。
 *
 * 用途：原生本地执行器 {@link NativeExecutor} 需要为每题 checkout 出尽量与官方一致的 Python 版本，
 * 再用 `uv` 拉起隔离 venv。本类提供「仓库 + 版本号 → Python 版本」的精选映射，作为官方 harness
 * `MAP_REPO_VERSION_TO_SPECS` 的 best-effort 子集。
 *
 * @maturity L1 — 判据：覆盖 Verified 高频仓库的精选子集；未命中回落安全默认 3.11。
 *   映射非官方全量，可能随仓库演进偏离；扩展只需补 {@link PYTHON_VERSIONS}。
 *   降级链 {@link DEGRADATION} 处理「官方要求 3.6/3.7 但 `uv` 仅可供给 3.8–3.15（3.6/3.7 不可得）」
 *   的保真度缺口：拒绝「因版本不可 provision 而整题 infra 失败」，回落到最近可用版本。
 * @maturityEvidence tests/unit/swebenchVerified.test.ts
 */
export class PythonVersionResolver {
  /** 仓库 →（版本号 → Python 版本）精选映射（best-effort，非官方全量）。 */
  private static readonly PYTHON_VERSIONS: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = {
    'django/django': {
      '1.11': '3.6',
      '2.0': '3.6',
      '2.1': '3.7',
      '2.2': '3.7',
      '3.0': '3.8',
      '3.1': '3.8',
      '3.2': '3.8',
      '4.0': '3.8',
      '4.1': '3.8',
      '4.2': '3.8',
      // 5.0 要求 Python ≥3.10（3.11 恰好等于 FALLBACK，显式登记以免被读成「漏登记」）。
      '5.0': '3.11',
    },
    'django-rest-framework/django-rest-framework': {
      '3.8': '3.7',
      '3.9': '3.8',
      '3.10': '3.8',
      '3.11': '3.8',
      '3.12': '3.8',
      '3.13': '3.8',
      '3.14': '3.8',
      '3.15': '3.8',
    },
    'scikit-learn/scikit-learn': {
      '0.19': '3.6',
      '0.20': '3.6',
      '0.21': '3.7',
      '0.22': '3.7',
      '0.23': '3.7',
      '0.24': '3.8',
      '1.0': '3.8',
      '1.1': '3.8',
      '1.2': '3.8',
      '1.3': '3.8',
    },
    'matplotlib/matplotlib': {
      '3.0': '3.7',
      '3.1': '3.7',
      '3.2': '3.7',
      '3.3': '3.8',
      '3.4': '3.8',
      '3.5': '3.8',
      '3.6': '3.8',
      '3.7': '3.8',
    },
    'sympy/sympy': { '1.0': '3.7', '1.1': '3.7', '1.10': '3.8', '1.11': '3.8', '1.12': '3.8' },
    'pytest-dev/pytest': {
      '4.5': '3.7',
      '4.6': '3.7',
      '5.0': '3.7',
      '5.1': '3.7',
      '5.2': '3.7',
      '5.3': '3.7',
      '5.4': '3.7',
      '6.0': '3.8',
      '6.1': '3.8',
      '6.2': '3.8',
      '6.3': '3.8',
      '7.0': '3.8',
      '7.1': '3.8',
      '7.2': '3.8',
      '7.3': '3.8',
      '7.4': '3.8',
      '8.0': '3.8',
    },
    // ⚠️ 次版本号**必须显式登记**：前缀匹配用的是 `version.startsWith(key)`，`5.1` 不以 `5.0` 开头
    // ⇒ 只写 `5.0` 时 `5.1` 会落到 FALLBACK（3.11）。实测 sphinx 5.1 因此跑在 3.11 上而 gold 判不过。
    'sphinx-doc/sphinx': {
      '3.0': '3.8',
      '3.1': '3.8',
      '3.2': '3.8',
      '3.3': '3.8',
      '3.4': '3.8',
      '3.5': '3.8',
      '4.0': '3.8',
      '4.1': '3.8',
      '4.2': '3.8',
      '4.3': '3.8',
      '4.4': '3.8',
      '4.5': '3.8',
      '5.0': '3.8',
      '5.1': '3.8',
      '5.2': '3.8',
      '5.3': '3.8',
      '6.0': '3.8',
      '6.1': '3.8',
      '6.2': '3.8',
      '7.0': '3.8',
      '7.1': '3.8',
      '7.2': '3.9',
      '7.3': '3.9',
    },
    // xarray 此前**整仓缺登记** ⇒ 0.12（2019 年）与 2022.06 都跑在 FALLBACK 3.11 上：
    // 0.12 的依赖栈在 3.11 上根本装不起来（gold 恒判未通过）。官方口径 0.12 用 3.6（本仓降级链 → 3.8）。
    'pydata/xarray': {
      '0.10': '3.6',
      '0.11': '3.6',
      '0.12': '3.6',
      '0.13': '3.6',
      '0.14': '3.7',
      '0.15': '3.7',
      '0.16': '3.7',
      '0.17': '3.8',
      '0.18': '3.8',
      '0.19': '3.8',
      '0.20': '3.8',
      '0.21': '3.8',
      '2022.03': '3.8',
      '2022.06': '3.8',
      '2022.09': '3.9',
      '2022.10': '3.9',
      '2022.12': '3.9',
      '2023.01': '3.9',
      '2023.02': '3.9',
      '2023.03': '3.9',
      '2023.04': '3.9',
      '2023.05': '3.9',
    },
    'psf/requests': {
      // 实测（2026-09-26）：`2.4` / `2.9` 此前落 FALLBACK 3.11，而 requests 自带 vendored urllib3 用的是
      // `from collections import Mapping`（3.10 起移除）⇒ `uv pip install -e .` 直接 ImportError
      // ⇒ 该实例被记成模型失败。故把 2.9 及更早按官方口径登记（3.6/3.7 → 本仓降级链 → 3.8）。
      '1.1': '3.6',
      '2.0': '3.6',
      '2.3': '3.6',
      '2.4': '3.6',
      '2.9': '3.6',
      '2.10': '3.6',
      '2.11': '3.6',
      '2.12': '3.6',
      '2.18': '3.6',
      '2.19': '3.7',
      '2.20': '3.7',
      '2.21': '3.7',
      '2.22': '3.7',
      '2.23': '3.7',
      '2.24': '3.7',
      '2.25': '3.7',
      '2.26': '3.7',
      '2.27': '3.7',
      '2.28': '3.7',
      '2.29': '3.7',
      '2.30': '3.7',
      '2.31': '3.7',
      '2.32': '3.8',
    },
    'pylint-dev/pylint': {
      '2.0': '3.6',
      '2.1': '3.6',
      '2.2': '3.6',
      '2.3': '3.6',
      '2.4': '3.6',
      '2.5': '3.6',
      '2.6': '3.6',
      '2.7': '3.7',
      '2.8': '3.7',
      '2.9': '3.7',
      '2.10': '3.7',
      '2.11': '3.7',
      '2.12': '3.8',
      '2.13': '3.8',
      '2.14': '3.8',
      '2.15': '3.8',
      '3.0': '3.8',
    },
    'astropy/astropy': {
      // 1.3（2016 年）此前缺登记 ⇒ 跑在 FALLBACK 3.11 上。这里按官方口径登记 3.6（本仓降级链 → 3.8）；
      // ⚠️ 即便 Python 版本对齐，astropy 的 C 扩展（`astropy._erfa` 等）仍**必须编译**，
      // 无 C 工具链的主机上依旧装不起来 —— 这类应记 envError（环境阻塞），不是「模型未修好」。
      '1.3': '3.6',
      '3.1': '3.8',
      '4.0': '3.8',
      '4.1': '3.9',
      '4.2': '3.9',
      '4.3': '3.9',
      '5.0': '3.10',
      '5.1': '3.10',
      '5.2': '3.10',
      '5.3': '3.10',
      '6.0': '3.10',
    },
    'statsmodels/statsmodels': {
      '0.10': '3.6',
      '0.11': '3.7',
      '0.12': '3.7',
      '0.13': '3.8',
      '0.14': '3.8',
    },
    'mwaskom/seaborn': { '0.9': '3.6', '0.10': '3.7', '0.11': '3.7', '0.12': '3.8', '0.13': '3.8' },
  };

  /** 未命中映射时的回落默认 Python 版本（现代、通用）。 */
  private static readonly FALLBACK = '3.11';

  /**
   * 版本降级链：`uv` 仅可供给 **3.8–3.15** 的 Python（3.6/3.7 在官方分发中已不可得），
   * 而官方 harness 的 `MAP_REPO_VERSION_TO_SPECS` 把部分老仓库指向 3.6/3.7。若直接把 3.7 交给
   * `uv python find` / `uv venv --python 3.7`，会落到「版本不存在」⇒ 整题 infra 失败、连补丁都没跑。
   * 降级到「最近可用且尽量贴近」的版本（3.6/3.7 → 3.8）是严格优于「整题失败」的 best-effort：
   * 少数代码可能依赖 3.7 专属行为，但「跑在一边偏新的解释器」远好于「完全不跑」。
   * 键为映射产出的版本、值为回落版本；未列出的版本原样返回。
   */
  private static readonly DEGRADATION: Readonly<Record<string, string>> = {
    '3.6': '3.8',
    '3.7': '3.8',
  };

  /**
   * 解析某实例所需 Python 版本。
   * @param repo 仓库 slug（如 django/django）。
   * @param version 实例版本号（如 4.2）；空串按回落处理。
   * @returns 形如 "3.8" 的 Python 版本字符串（已应用 {@link DEGRADATION} 降级）。
   */
  public static resolve(repo: string, version: string): string {
    const mapped = PythonVersionResolver.mapRepoVersion(repo, version);
    return PythonVersionResolver.degrade(mapped);
  }

  /**
   * 把「仓库 + 版本号」映射到官方口径 Python 版本（不含降级链）。
   * @param repo 仓库 slug。
   * @param version 实例版本号；空串按回落处理。
   * @returns 映射版本或 {@link FALLBACK}。
   */
  private static mapRepoVersion(repo: string, version: string): string {
    const byRepo = PythonVersionResolver.PYTHON_VERSIONS[repo];
    if (byRepo !== undefined && version.length > 0) {
      const exact = byRepo[version];
      if (exact !== undefined) return exact;
      const prefixHit = Object.keys(byRepo).find((k) => version.startsWith(k));
      if (prefixHit !== undefined) {
        const mapped = byRepo[prefixHit];
        if (mapped !== undefined) return mapped;
      }
    }
    return PythonVersionResolver.FALLBACK;
  }

  /**
   * 应用 {@link DEGRADATION} 降级链：把 `uv` 不可 provision 的版本（3.6/3.7）回落到最近可用版本。
   * @param version 映射产出的版本（如 "3.7"）。
   * @returns 降级后版本（如 "3.8"）；无需降级则原样返回。
   */
  public static degrade(version: string): string {
    const down = PythonVersionResolver.DEGRADATION[version];
    return down ?? version;
  }

  /**
   * 列出已内置映射的仓库（诊断/扩展用）。
   * @returns 仓库 slug 列表。
   */
  public static supportedRepos(): readonly string[] {
    return Object.keys(PythonVersionResolver.PYTHON_VERSIONS);
  }
}
