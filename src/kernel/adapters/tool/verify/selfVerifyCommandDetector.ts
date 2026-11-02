/**
 * 自验证命令探测：从工作区里的**证据文件**推断该仓库的测试命令。
 *
 * 为什么必须探测而不是写死 `npm test`：原实现把「仓库有测试症状」定义为
 * 「`package.json` 含 `scripts.test`」，于是**非 JS 生态的仓库永远不启用自验证**
 * ——Python / Rust / Go / Java 仓库里 `SOURCE_EXTENSIONS`（含 `.py/.rs/.go/.java`）
 * 成了一组**不可达判据**；更糟的是**显式传 `selfVerify.command` 也照样被闸门挡住**
 * （闸门在覆盖之前），用户给出了正确命令却被静默忽略。
 *
 * 本类的取值口径：**只认证据，不猜**——每个命令都对应一个可复核的仓库特征
 * （配置文件名 / 显式测试段 / 测试目录与测试文件的命名约定）。证据不足即返回
 * `undefined`（不启用自验证），宁可少跑，也不生成一条跑不起来的命令。
 *
 * 探测顺序即优先级：JS/TS 最常见，其次 Python，再按生态铺开。同仓多生态时取首个命中。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 一条「测试症状 → 测试命令」规则。 */
interface TestSymptomRule {
  /** 命中后采用的测试命令。 */
  readonly command: string;
  /** 证据判定：给定仓库根目录，返回该症状是否成立。 */
  readonly matches: (root: string) => boolean;
}

/**
 * 测试命令探测器（无状态，纯静态）。
 */
export class SelfVerifyCommandDetector {
  /**
   * 探测某工作区的测试命令。
   *
   * @param workspaceRoot 仓库根目录（空串或不存在时返回 `undefined`）。
   * @returns 探测到的测试命令；无任何测试症状时为 `undefined`（不启用自验证）。
   */
  public static detect(workspaceRoot: string): string | undefined {
    const root = workspaceRoot.trim();
    if (root === '' || !existsSync(root)) {
      return undefined;
    }
    for (const rule of SelfVerifyCommandDetector.RULES) {
      try {
        if (rule.matches(root)) {
          return rule.command;
        }
      } catch {
        // 单个规则读取失败不影响其余规则（例如权限/编码问题），继续下探。
      }
    }
    return undefined;
  }

  /**
   * 探测规则表（顺序即优先级）。
   *
   * 每条规则的证据都可人工复核；`cargo test` / `go test ./...` / `pytest -q` 等
   * 都是各生态的**事实标准**入口，不依赖任何 npm 包或全局工具链之外的东西。
   */
  private static readonly RULES: readonly TestSymptomRule[] = [
    {
      command: 'npm test',
      matches: (root) => SelfVerifyCommandDetector.hasNpmTestScript(root),
    },
    {
      command: 'pytest -q',
      matches: (root) => SelfVerifyCommandDetector.hasPythonTestSymptom(root),
    },
    {
      command: 'cargo test',
      matches: (root) => existsSync(join(root, 'Cargo.toml')),
    },
    {
      command: 'go test ./...',
      matches: (root) => existsSync(join(root, 'go.mod')),
    },
    {
      command: 'mvn -q test',
      matches: (root) => existsSync(join(root, 'pom.xml')),
    },
    {
      command: 'gradle test',
      matches: (root) =>
        existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts')),
    },
    {
      command: 'bundle exec rspec',
      matches: (root) =>
        existsSync(join(root, 'Gemfile')) &&
        SelfVerifyCommandDetector.hasAny(root, ['.rspec', 'spec']),
    },
    {
      command: 'dotnet test',
      matches: (root) => SelfVerifyCommandDetector.hasAnySuffix(root, ['.sln', '.csproj']),
    },
    {
      command: 'make test',
      matches: (root) => SelfVerifyCommandDetector.makefileHasTestTarget(root),
    },
  ];

  /**
   * `package.json` 是否声明了非空的 `scripts.test`。
   *
   * @param root 仓库根目录。
   * @returns 存在测试脚本时为 true（文件缺失/解析失败/脚本为空时为 false，不抛错）。
   */
  private static hasNpmTestScript(root: string): boolean {
    const raw = SelfVerifyCommandDetector.read(root, 'package.json');
    if (raw === undefined) {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) {
      return false;
    }
    const test = (scripts as Record<string, unknown>)['test'];
    return typeof test === 'string' && test.trim() !== '';
  }

  /**
   * 是否存在 Python 测试症状。
   *
   * 证据（任一即可）：pytest 配置（`pytest.ini` / `tox.ini` / `setup.cfg` 的测试段 /
   * `pyproject.toml` 含 pytest 配置）、`conftest.py`、或 `tests`/`test` 目录下的
   * `test_*.py` / `*_test.py`。刻意要求**同时有测试文件或配置**，避免仅凭
   * 「装了 pytest」就误判一个纯脚本目录。
   *
   * @param root 仓库根目录。
   * @returns 有 Python 测试症状时为 true。
   */
  private static hasPythonTestSymptom(root: string): boolean {
    if (existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'conftest.py'))) {
      return true;
    }
    const tox = SelfVerifyCommandDetector.read(root, 'tox.ini');
    if (tox !== undefined && /\[(?:pytest|tox)\]/i.test(tox)) {
      return true;
    }
    const setupCfg = SelfVerifyCommandDetector.read(root, 'setup.cfg');
    if (setupCfg !== undefined && /\[tool:pytest\]/i.test(setupCfg)) {
      return true;
    }
    const pyproject = SelfVerifyCommandDetector.read(root, 'pyproject.toml');
    if (pyproject !== undefined && /pytest/i.test(pyproject)) {
      return true;
    }
    return (
      SelfVerifyCommandDetector.hasPythonTestFile(root, 'tests') ||
      SelfVerifyCommandDetector.hasPythonTestFile(root, 'test')
    );
  }

  /**
   * 某目录下是否有 `test_*.py` / `*_test.py`。
   *
   * @param root 仓库根目录。
   * @param dir 相对目录名（如 `tests`）。
   * @returns 命中测试文件命名约定时为 true。
   */
  private static hasPythonTestFile(root: string, dir: string): boolean {
    for (const name of SelfVerifyCommandDetector.listDir(root, dir)) {
      if (/^(?:test_.*|.*_test)\.py$/i.test(name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * `Makefile` 是否声明了 `test` 目标。
   *
   * 必须**保守**：`make test` 只有在确实存在该目标时才成立，否则这条自验证命令
   * 每次都会以 `No rule to make target 'test'` 失败——比不启用更糟（浪费预算 + 假信号）。
   * 因此要挡住两类看着像目标的写法：
   * - 变量赋值 `test := 1` / `test = 1`（`:` 后紧跟 `=`）；
   * - 仅作前缀的其它目标 `test-all:`（`test` 后必须是行尾或 `:`，不能是 `-`）。
   *
   * @param root 仓库根目录。
   * @returns 存在 `test:` 目标时为 true。
   */
  private static makefileHasTestTarget(root: string): boolean {
    const makefile = SelfVerifyCommandDetector.read(root, 'Makefile');
    return makefile !== undefined && /^test[ \t]*:(?!=)/m.test(makefile);
  }

  /**
   * 根目录下是否存在这些相对路径中的任意一个。
   *
   * @param root 仓库根目录。
   * @param candidates 候选相对路径。
   * @returns 任一存在时为 true。
   */
  private static hasAny(root: string, candidates: readonly string[]): boolean {
    return candidates.some((rel) => existsSync(join(root, rel)));
  }

  /**
   * 根目录下是否存在以给定后缀结尾的文件（用于 `*.sln` / `*.csproj`）。
   *
   * @param root 仓库根目录。
   * @param suffixes 候选后缀（小写）。
   * @returns 任一命中时为 true。
   */
  private static hasAnySuffix(root: string, suffixes: readonly string[]): boolean {
    const names = SelfVerifyCommandDetector.listDir(root, '.');
    return names.some((name) => suffixes.some((suffix) => name.toLowerCase().endsWith(suffix)));
  }

  /**
   * 读取相对路径文件内容。
   *
   * @param root 仓库根目录。
   * @param rel 相对路径。
   * @returns 文件文本；不存在或读取失败时为 `undefined`（不抛错）。
   */
  private static read(root: string, rel: string): string | undefined {
    try {
      return readFileSync(join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * 列出目录下的条目名（非递归）。
   *
   * @param root 仓库根目录。
   * @param rel 相对目录（`.` 表示根目录本身）。
   * @returns 条目名数组；目录不存在或读取失败时为空数组（不抛错）。
   */
  private static listDir(root: string, rel: string): readonly string[] {
    try {
      return readdirSync(rel === '.' ? root : join(root, rel));
    } catch {
      return [];
    }
  }
}
