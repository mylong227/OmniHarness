/**
 * 测试命令定向收窄：把「上次跑挂的文件」变成一条**只跑失败那批**的命令。
 *
 * 设计口径（两条都是踩出来的）：
 *
 * ① **只接受「像测试文件」的目标**。堆栈帧多数指向**被测源码**（`src/core/foo.ts`），
 *    把它透传给运行器会被判成「没有匹配的测试」而**假失败**——假失败比不做定向更贵
 *    （模型会去追一个并不存在的回归）。故先过 {@link TestCommandNarrower.isTestPath}。
 * ② **只对「参数约定是事实标准」的运行器收窄**。每条规则都用该运行器**文档化的**
 *    收窄方式（npm `--` 透传、pytest 位置参数、`cargo --test`、`mvn -Dtest`、
 *    `gradle --tests`、`go test <目录>`、`dotnet --filter`），**不做字符串瞎拼**；
 *    认不出的命令一律原样返回（退回全量）。
 *
 * 原实现只认 `npm test`，于是 Python / Rust / Go / Java 仓库的「定向测试」恒等于全量
 * ——对分钟级的 sympy/pytest 类仓库，这意味着一次改错的代价是每次全量重跑。
 */
import { dirname } from 'node:path';

/** 一条运行器收窄规则。 */
interface NarrowingRule {
  /** 命令是否属于该运行器（匹配命令开头）。 */
  readonly pattern: RegExp;
  /**
   * 从测试文件路径推出该运行器要的目标（返回 `undefined` 表示这个文件不适用本规则）。
   */
  readonly targetOf: (file: string) => string | undefined;
  /** 去掉命令尾部已有的「范围参数」再追加目标（如 `go test ./...` 的 `./...`）。 */
  readonly strip?: RegExp;
  /** 把目标拼进命令。 */
  readonly build: (command: string, targets: readonly string[]) => string;
}

/**
 * 测试命令定向收窄器（无状态，纯静态）。
 */
export class TestCommandNarrower {
  /** 单次定向最多收窄到的目标数（命令行长度的隐式上界）。 */
  public static readonly MAX_TARGETS = 8;

  /**
   * 该路径是否像**测试文件**（定向测试只接受测试文件）。
   *
   * 刻意保守：只认各生态的**命名约定**，不认「在 tests 目录里就是测试」——
   * 后者会把 `tests/fixtures.ts` 之类助手文件也透传进去，运行器会因「该文件没有测试」
   * 报错（又是一次假失败）。唯二的目录型例外是 Rust 的 `tests/<name>.rs`
   * 与 Java/C# 的 `src/test/**`，这两处「目录 + 命名」本身就是 cargo/Maven 的
   * 集成测试寻址方式，不是猜测。
   *
   * @param file 路径（相对或绝对，可含 `\`）。
   * @returns 形如测试文件时为 true。
   */
  public static isTestPath(file: string): boolean {
    const normalized = TestCommandNarrower.normalize(file);
    const base = normalized.split('/').pop() ?? '';
    if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(base)) {
      return true;
    }
    if (/^(?:test_.*|.*_test|.*_spec)\.(?:py|rb)$/i.test(base)) {
      return true;
    }
    if (/^.*_test\.go$/i.test(base)) {
      return true;
    }
    if (/^.*(?:Tests?|IT)\.(?:java|cs|kt)$/i.test(base)) {
      return true;
    }
    // Rust 集成测试只有 `tests/<name>.rs` 这一层会被 cargo 认作测试单元。
    return /(?:^|\/)tests\/[^/]+\.rs$/i.test(normalized);
  }

  /**
   * 把命令收窄到给定的失败文件上。
   *
   * @param command 策略持有的测试命令。
   * @param files 上次失败输出里解析到的文件清单（可为空、可含非测试文件、可含重复）。
   * @returns 定向命令；无可用目标或命令形态不识别时返回原 `command`。
   */
  public static narrow(command: string, files: readonly string[]): string {
    const rule = TestCommandNarrower.RULES.find((item) => item.pattern.test(command.trim()));
    if (rule === undefined) {
      return command;
    }
    const targets: string[] = [];
    for (const raw of files) {
      if (targets.length >= TestCommandNarrower.MAX_TARGETS) {
        break;
      }
      const file = raw.trim();
      if (file === '' || !TestCommandNarrower.isTestPath(file)) {
        continue;
      }
      const target = rule.targetOf(file);
      if (target !== undefined && target !== '' && !targets.includes(target)) {
        targets.push(target);
      }
    }
    if (targets.length === 0) {
      return command;
    }
    const base = rule.strip === undefined ? command : command.replace(rule.strip, '').trimEnd();
    return rule.build(base, targets);
  }

  /**
   * 路径归一化为正斜杠（堆栈帧里两种分隔符都会出现）。
   *
   * @param file 原始路径。
   * @returns 正斜杠路径。
   */
  private static normalize(file: string): string {
    return file.split('\\').join('/');
  }

  /**
   * 把目标按空格拼到命令尾部（npm/pytest/jest/rspec 的共用形态）。
   *
   * @param separator 连接符（`--` 或空）。
   * @returns 拼接函数。
   */
  private static appendWith(
    separator: string,
  ): (command: string, targets: readonly string[]) => string {
    return (command, targets) =>
      separator === ''
        ? `${command} ${targets.join(' ')}`
        : `${command} ${separator} ${targets.join(' ')}`;
  }

  /**
   * 从路径里抽出 `marker` 之后的包路径并转成点分全限定名（Maven/Gradle 形态）。
   *
   * @param file 测试文件路径。
   * @param marker 包根标记（如 `src/test/java/`）。
   * @returns 形如 `com.x.FooTest` 的全限定名；无标记时为 `undefined`。
   */
  private static fqcnAfter(file: string, marker: string): string | undefined {
    const normalized = TestCommandNarrower.normalize(file);
    // 标记自带前导 `/`（更不易误命中），故相对路径要先补一个，否则 `src/test/java/...` 会漏判。
    const padded = normalized.startsWith('/') ? normalized : `/${normalized}`;
    const at = padded.indexOf(marker);
    if (at < 0) {
      return undefined;
    }
    const tail = padded.slice(at + marker.length).replace(/\.(?:java|kt)$/i, '');
    return tail === '' ? undefined : tail.split('/').join('.');
  }

  /**
   * Go 形态：测试文件的**所在包目录**（`./pkg/a`）。
   *
   * 绝对路径会被拒绝——`go test` 认的是包路径而不是文件系统位置，把绝对路径塞进去
   * 只会得到一条跑不起来的命令（宁可退回全量）。
   *
   * @param file 测试文件路径。
   * @returns `./` 前缀的包目录；绝对路径时返回 `undefined`。
   */
  private static goPackageOf(file: string): string | undefined {
    const normalized = TestCommandNarrower.normalize(file);
    if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
      return undefined;
    }
    const dir = dirname(normalized);
    return dir === '' || dir === '.' ? undefined : `./${dir}`;
  }

  /**
   * 收窄规则表（顺序即匹配优先级）。
   */
  private static readonly RULES: readonly NarrowingRule[] = [
    {
      // npm / pnpm / yarn 的 `--` 透传是事实标准：`npm test -- path/to/x.test.ts`。
      pattern: /^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?:\s|$)/,
      targetOf: (file) => TestCommandNarrower.normalize(file),
      build: TestCommandNarrower.appendWith('--'),
    },
    {
      // pytest 直接吃位置参数（文件或目录）。
      pattern: /^(?:python[23]?\s+-m\s+)?pytest(?:\s|$)/,
      targetOf: (file) => TestCommandNarrower.normalize(file),
      build: TestCommandNarrower.appendWith(''),
    },
    {
      pattern: /^(?:npx\s+|node\s+\S*\/)?(?:jest|vitest|mocha)(?:\s|$)/,
      targetOf: (file) => TestCommandNarrower.normalize(file),
      build: TestCommandNarrower.appendWith(''),
    },
    {
      pattern: /^(?:bundle\s+exec\s+)?rspec(?:\s|$)/,
      targetOf: (file) => TestCommandNarrower.normalize(file),
      build: TestCommandNarrower.appendWith(''),
    },
    {
      // `go test ./...` 的范围参数要先去掉了再换成包目录，否则会变成 `go test ./... ./pkg`。
      pattern: /^go\s+test(?:\s|$)/,
      targetOf: TestCommandNarrower.goPackageOf,
      strip: /\s+\.{1,2}(?:\/\.\.\.)?\s*$/,
      build: (command, targets) => `${command} ${targets.join(' ')}`,
    },
    {
      // cargo 只把 `tests/<name>.rs` 当独立测试目标，收窄方式即 `--test <name>`。
      pattern: /^cargo\s+test(?:\s|$)/,
      targetOf: (file) =>
        /(?:^|\/)tests\/([^/]+)\.rs$/i.exec(TestCommandNarrower.normalize(file))?.[1],
      build: (command, targets) => `${command}${targets.map((t) => ` --test ${t}`).join('')}`,
    },
    {
      pattern: /(?:^|\s)mvn(?:\.cmd)?\s+(?:.*\s)?test(?:\s|$)/,
      targetOf: (file) => TestCommandNarrower.fqcnAfter(file, '/src/test/java/')?.split('.').pop(),
      build: (command, targets) => `${command} -Dtest=${targets.join(',')}`,
    },
    {
      pattern: /(?:^|\/)?gradle(?:w)?(?:\.bat)?\s+(?:.*\s)?test(?:\s|$)/,
      targetOf: (file) => TestCommandNarrower.fqcnAfter(file, '/src/test/java/'),
      build: (command, targets) => `${command}${targets.map((t) => ` --tests ${t}`).join('')}`,
    },
    {
      // dotnet 的 `--filter` 只能给一条表达式，多目标用 `|` 连接会撞 shell 管道
      // ⇒ 只取首个目标并整体加引号（引号内无 `$`/反引号，透传安全）。
      pattern: /^dotnet\s+test(?:\s|$)/,
      targetOf: (file) => /(?:^|\/)([^/]+)\.cs$/i.exec(TestCommandNarrower.normalize(file))?.[1],
      build: (command, targets) => `${command} --filter "FullyQualifiedName~${targets[0] ?? ''}"`,
    },
  ];
}
