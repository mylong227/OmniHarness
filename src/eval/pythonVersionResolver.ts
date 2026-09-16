/**
 * SWE-bench 实例所需 Python 版本解析（纯函数，零 IO、零依赖）。
 *
 * 用途：原生本地执行器 {@link NativeExecutor} 需要为每题 checkout 出尽量与官方一致的 Python 版本，
 * 再用 `uv` 拉起隔离 venv。本类提供「仓库 + 版本号 → Python 版本」的精选映射，作为官方 harness
 * `MAP_REPO_VERSION_TO_SPECS` 的 best-effort 子集。
 *
 * @maturity L1 — 判据：覆盖 Verified 高频仓库的精选子集；未命中回落安全默认 3.11。
 *   映射非官方全量，可能随仓库演进偏离；扩展只需补 {@link PYTHON_VERSIONS}。
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
      '4.6': '3.7',
      '5.4': '3.7',
      '6.2': '3.8',
      '7.0': '3.8',
      '7.1': '3.8',
      '7.2': '3.8',
      '7.3': '3.8',
      '7.4': '3.8',
      '8.0': '3.8',
    },
    'sphinx-doc/sphinx': { '4.0': '3.8', '5.0': '3.8', '6.0': '3.8', '7.0': '3.8' },
    'psf/requests': {
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
   * 解析某实例所需 Python 版本。
   * @param repo 仓库 slug（如 django/django）。
   * @param version 实例版本号（如 4.2）；空串按回落处理。
   * @returns 形如 "3.8" 的 Python 版本字符串。
   */
  public static resolve(repo: string, version: string): string {
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
   * 列出已内置映射的仓库（诊断/扩展用）。
   * @returns 仓库 slug 列表。
   */
  public static supportedRepos(): readonly string[] {
    return Object.keys(PythonVersionResolver.PYTHON_VERSIONS);
  }
}
