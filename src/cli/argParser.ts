import type { FileConfig } from '../config/configFile.ts';
import { CliFlagTable, FLAG_TABLE, VALUE_FLAGS } from './cliFlagTable.ts';
import { ArgConfigDefaults } from './argConfigDefaults.ts';
import { SessionStorageLocation } from '../util/sessionStorageLocation.ts';
import { ArrayAt } from '../util/arrayAt.ts';
import { providerPresets, type ProviderPreset } from '../server/services/providerPresets.ts';
import { cliHelp } from './cliHelp.ts';
import { FlagSuggestion } from './flagSuggestion.ts';

export * from './cliEnums.ts';
export { CliFlagTable } from './cliFlagTable.ts';

export type { CliArgs } from './cliArgs.ts';
import type { CliArgs } from './cliArgs.ts';

/** CLI 默认值。 */
export const CliDefaults: CliArgs = {
  modelAdapter: 'mock',
  model: 'deepseek-v4-flash',
  storageAdapter: 'jsonl',
  // 单一事实源：`trace` / `session` 等独立读取方**必须**用同一个 `SessionStorageLocation`
  // （2026-10-06 第五十九轮：此前四处各写一份，默认跑一次再 `trace read` 必然找不到会话）。
  storageDir: SessionStorageLocation.defaultDir(),
  approval: 'rules',
  approvalAsk: 'allow',
  sandbox: 'policy',
  escalation: 'deny',
  elevatedSandbox: 'policy',
  events: 'console',
  spillAdapter: 'file',
  toolFiles: [],
  prompt: '',
  workspace: process.cwd(),
  // **0 = 不限**（2026-10-15 产品口径：合理的是把任务做完，而不是限制步数）。
  // 实证：定位重、落盘轻的任务（先读 10+ 文件/跑 tsc 再写）在 16/32/48 下都会「探索烧满配额、
  // 修复零落盘」（sess_mv9nl59c）——问题不在配额大小，而在**拿配额当终止条件**。
  // 终止改为：模型产出结论（完成闸门）/ token 与成本预算 / LoopGuard 行为护栏 / 用户取消。
  // 需要硬上限时显式给：`--max-steps N` 或配置 `"maxSteps": N`。
  maxSteps: 0,
  mcpServers: [],
  workerExternals: [],
  native: true,
  planMode: false,
};

/** 适配器厂商预设（id + baseUrl）——完整形状见 `config/providerPresets.ts` 的 `ProviderPreset`。 */
type AdapterPreset = ProviderPreset;

/**
 * CLI 参数解析器：原模块级纯函数归拢为 `ArgParser` 方法族，现改为实例方法以消除 `static`；
 * 调用点通过同名门面函数零改动继续引用；`CliDefaults` / `CliArgs` / re-export 保持不变。
 */
export class ArgParser {
  /**
   * 收集非旗标的位置参数（回退为 prompt，如 `omniharness "fix bug"`）。
   * @param argv 原始命令行参数。
   * @returns 位置参数列表（按出现顺序；旗标本身及其取值不计入）。
   */
  private collectPositional(argv: readonly string[]): string[] {
    const out: string[] = [];
    for (let k = 0; k < argv.length; k += 1) {
      const a = argv[k];
      if (a === undefined || a.startsWith('--')) {
        continue;
      }
      const prev = argv[k - 1];
      if (prev !== undefined && VALUE_FLAGS.has(prev)) {
        continue;
      }
      out.push(a);
    }
    return out;
  }

  /**
   * 把 GitBash / MSYS 风格路径（如 `/d/deepseek/x`）转换为本机 Windows 路径（`D:\deepseek\x`）。
   * Windows 上 node 的 path.join 不会解析 `/d/...`，会把它当成「当前盘符根下的 \d\...」，
   * 导致配置文件/工作区落到错位目录（如 D:\d\deepseek\...）。serve 在 GitBash 下接收的参数
   * 多为该风格，统一在此转换，避免 fs.list / config.update 落盘路径错乱。
   * @param p 任意风格路径。
   * @returns 本机 Windows 风格路径（非 MSYS 风格输入原样返回，仅统一分隔符）。
   */
  public toWindowsPath(p: string): string {
    let s = p.trim();
    const drive = s.match(/^\/([a-zA-Z])\/(.*)$/);
    if (drive !== null) {
      s = `${ArrayAt.at(drive, 1).toUpperCase()}:/${ArrayAt.at(drive, 2)}`;
    }
    return s.replace(/\//g, '\\');
  }

  /**
   * 解析 CLI 参数：以 CliDefaults（可被 defaults 覆盖）为基底，逐个消费 argv 中的旗标
   * （查 FLAG_TABLE 调用处理器；遇 --help 直接返回 undefined），最后把非旗标位置参数
   * 回填为 prompt（prompt 为空时）。resume/fork 模式必须显式提供 --prompt。
   * @param argv 原始命令行参数（不含 node 与脚本入口两个元素）
   * @param defaults 额外默认值（如配置文件合并结果），逐字段覆盖在 CliDefaults 之上
   * @returns 解析后的完整参数；undefined 表示 --help，或既无 prompt 又无 --replay（无事可做）
   * @throws resume/fork 模式缺 --prompt 时抛错
   */
  public parseArgs(argv: readonly string[], defaults?: Partial<CliArgs>): CliArgs | undefined {
    const args: CliArgs = { ...CliDefaults, ...(defaults ?? {}) };
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === undefined) {
        continue;
      }
      if (arg === '--help') {
        return undefined;
      }
      if (arg === '--') {
        // 显式选项结束符：其后的 token 一律按位置参数处理（由 `collectPositional` 统一收集），
        // 便于把以 `-` 开头的 prompt 原样传入而不触发下面的未知旗标判定。
        break;
      }
      const handler = FLAG_TABLE[arg];
      if (handler !== undefined) {
        i += handler(args, argv, i);
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        // **未知旗标 fail-closed**（2026-10-06 第五十七轮 ⑥）：修复前这里什么都不做（静默 `continue`），
        // 于是①拼错的旗标**无声无效**；②它的取值还会被 `collectPositional` 当成 prompt
        // （`--porad x` ⇒ prompt 变成 `x`）——这是本板"拼错 = 没生效"反复出现的共同放大器。
        // 认识的旗标 = FLAG_TABLE ∪ VALUE_FLAGS ∪ 子命令/装配层自解析清单（`KNOWN_EXTRA_FLAGS`，
        // 由 `tests/unit/knownFlags.test.ts` 与源码里的读取点机械对齐）。
        if (CliFlagTable.isKnownFlag(arg)) {
          // 子命令 / 装配层自解析的旗标：本层不消费（其读取器在各自子命令里），但**认识**它。
          continue;
        }
        // 已知旗标清单**由调用方注入**（而不是让 flagSuggestion 反向 import cliFlagTable）：
        // 那会把它拖进架构门禁白名单环①，把 4 成员的环撑成 5 成员 ⇒ 门禁报"新增环"。
        throw new Error(FlagSuggestion.unknownFlagMessage(arg, CliFlagTable.knownFlagNames()));
      }
    }
    const positional = this.collectPositional(argv);
    if (args.prompt === '' && positional.length > 0) {
      args.prompt = positional.join(' ');
    }
    if (args.dumpConfig) {
      return args;
    }
    if (args.prompt === '' && args.replayId === undefined) {
      return undefined;
    }
    if (args.prompt === '' && (args.resumeId !== undefined || args.forkId !== undefined)) {
      throw new Error('resume/fork 模式需要 --prompt');
    }
    return args;
  }

  /**
   * 长期记忆落盘加密的两个配置键映射（2026-10-01 审计补接线）。
   *
   * `FileConfig` 早就声明了 `longTermMemoryEncryption` / `longTermMemoryKeyFile`，但
   * `configDefaults` 从不映射它们，于是写在 `omniharness.json` 里的
   * `longTermMemoryEncryption: true` 静默无效 —— 用户以为已加密，实际长期记忆以明文落盘。
   * 这是「静态加密开关」类配置里最不该静默的一种（此前只有 `--memory-encrypt` 旗标这一条路径生效）。
   *
   * @param file 已加载的项目配置文件对象。
   * @param result 待填充的 CLI 默认值（就地写入）。
   * @returns 无返回值（就地修改 `result`）。
   */
  private static applyMemoryEncryptionDefaults(file: FileConfig, result: Partial<CliArgs>): void {
    if (file.longTermMemoryEncryption !== undefined) {
      result.memoryEncrypt = file.longTermMemoryEncryption;
    }
    if (file.longTermMemoryKeyFile !== undefined) {
      result.memoryKeyFile = file.longTermMemoryKeyFile;
    }
  }

  /**
   * （U4/GEE Kernel v1）evolutionRlvr 文件对象形态 → 扁平 CliArgs 字段。
   * Kernel 子键（kernel/ledgerDir/archiveMaxPerBucket）不映射 = 「声明未接线」（CLI 通道丢配置）。
   * @param file 已加载的项目配置文件对象（读 `evolutionRlvr`）。
   * @param result 待填充的 CLI 默认值（就地写入）。
   * @returns 无返回值（就地修改 `result`）。
   */
  private static applyEvolutionRlvrDefaults(file: FileConfig, result: Partial<CliArgs>): void {
    const rlvr = file.evolutionRlvr;
    if (rlvr === undefined) {
      return;
    }
    if (rlvr.enabled !== undefined) {
      result.evolutionRlvr = rlvr.enabled;
    }
    if (rlvr.verifyCommand !== undefined) {
      result.rlvrVerify = rlvr.verifyCommand;
    }
    if (rlvr.samplesPerPrompt !== undefined) {
      result.rlvrSamples = rlvr.samplesPerPrompt;
    }
    if (rlvr.minReward !== undefined) {
      result.rlvrMinReward = rlvr.minReward;
    }
    if (rlvr.maxCandidates !== undefined) {
      result.rlvrCandidates = rlvr.maxCandidates;
    }
    if (rlvr.minGain !== undefined) {
      result.rlvrMinGain = rlvr.minGain;
    }
    if (rlvr.autoRun !== undefined) {
      result.rlvrAutoRun = rlvr.autoRun;
    }
    if (rlvr.kernel !== undefined) {
      result.evolutionKernel = rlvr.kernel;
    }
    if (rlvr.ledgerDir !== undefined) {
      result.rlvrLedgerDir = rlvr.ledgerDir;
    }
    if (rlvr.archiveMaxPerBucket !== undefined) {
      result.rlvrArchiveMax = rlvr.archiveMaxPerBucket;
    }
  }

  /**
   * 配置文件 → CLI 默认参数（仅合并已定义字段）。
   *
   * 映射按域分组（工具与资产段 / 模型与凭据 / 存储审批权限 / 运维预算与互操作），
   * 各域一个 `apply*Defaults` 私有方法——本方法只做调度，防止单体膨胀。
   * @param file 已加载的项目配置文件对象。
   * @returns 可覆盖在 CliDefaults 之上的默认值子集（providerKeys 会按适配器补全 apiKey/baseUrl）。
   */
  public configDefaults(file: FileConfig): Partial<CliArgs> {
    const result: Partial<CliArgs> = {};
    ArgConfigDefaults.applyToolSection(file, result);
    ArgConfigDefaults.applyModel(file, result, () => this.fillProviderCredentials(file, result));
    ArgConfigDefaults.applyStorageApproval(file, result, () =>
      ArgParser.applyMemoryEncryptionDefaults(file, result),
    );
    ArgConfigDefaults.applyOpsBudget(file, result, () =>
      ArgParser.applyEvolutionRlvrDefaults(file, result),
    );
    return result;
  }

  /**
   * 凭据兜底：顶层 `apiKey` / `baseUrl` 缺失时，用 `providerKeys` 里命中的厂商预设补全。
   *
   * 由来：修复 #OBS-2「UI 用 providerKeys 配的 key，CLI 启动却因缺 apiKey 崩」——
   * 按 `modelAdapter` 枚举所有可能厂商预设，取第一个在 `providerKeys` 里有 key 的。
   * 目录用**生效目录**（内建 `defaults/providers.json` + 用户 `providerPresets` 覆盖），
   * 自建/私有化厂商同样能被命中（否则 UI 配了 Key、CLI 却认不到该厂商）。
   * @param file 已加载的分层配置。
   * @param result 正在组装的 CLI 默认值（原地写入 `apiKey` / `baseUrl`）。
   * @returns 无返回值（无适配器声明或凭据已齐时直接返回）。
   */
  private fillProviderCredentials(file: FileConfig, result: Partial<CliArgs>): void {
    if (file.modelAdapter === undefined) return;
    if (file.apiKey !== undefined && file.baseUrl !== undefined) return;
    const providerKeys = file.providerKeys ?? {};
    const effectivePresets = providerPresets.resolve(file.providerPresets);
    for (const preset of this.adapterPresets(file.modelAdapter, effectivePresets)) {
      const presetKey = providerKeys[preset.id];
      if (presetKey !== undefined) {
        if (file.apiKey === undefined) result.apiKey = presetKey;
        if (file.baseUrl === undefined) result.baseUrl = preset.baseUrl;
        return;
      }
    }
  }

  /**
   * 打印用法。
   * @returns 无返回值。
   */
  /** 打印用法（文案在 `defaults/cliHelp.json`；枚举取值在渲染时从 `cliEnums` 派生）。
   * @returns 无返回值。
   */
  public printUsage(): void {
    process.stdout.write(cliHelp.render());
  }

  /**
   * 提取错误消息。
   * @param error 任意抛出值。
   * @returns Error 实例取 message，其余取 String(error)。
   */
  public messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 按 CLI `--model-adapter` 反查厂商预设。
   *
   * 来源为**单一目录**（`config/providerPresets.ts`，数据在 `defaults/providers.json`）：
   * 本类此前独立维护一份手工副本 `ADAPTER_PRESETS`（注释自称「同源同步」），加一家厂商要改两处、
   * 且两处漂移会出现「UI 有这家厂商、CLI 解析不到」的隐性缺口——已删除。CLI 专属映射
   * （`responses` → openai、`llamacpp` → ollama）改由预设自带的 `cliAdapters` 数据表达。
   * @param adapter CLI `--model-adapter` 取值。
   * @param presets 生效目录（缺省内建目录；调用方传 `providerPresets.resolve(file.providerPresets)`
   *   以纳入 `omniharness.json` 的用户覆盖）。
   * @returns 首个厂商预设；适配器无预设时返回 undefined。
   */
  public adapterToPreset(
    adapter: string,
    presets?: readonly ProviderPreset[],
  ): AdapterPreset | undefined {
    const list = this.adapterPresets(adapter, presets);
    return list.length === 0 ? undefined : list[0];
  }

  /**
   * 取适配器下所有可能厂商预设（按 baseUrl 一一对应）。
   * @param adapter CLI `--model-adapter` 取值。
   * @param presets 生效目录（缺省内建目录）。
   * @returns 预设列表（未知适配器返回空数组）。
   */
  public adapterPresets(
    adapter: string,
    presets?: readonly ProviderPreset[],
  ): readonly AdapterPreset[] {
    return providerPresets.forAdapter(adapter, presets);
  }

  /** GitBash / MSYS 路径 → 本机 Windows 路径。 */
  public static toWindowsPath(p: string): string {
    return argParser.toWindowsPath(p);
  }

  /** 解析 CLI 参数（`undefined` 表示 --help 或无任务）。 */
  public static parseArgs(
    argv: readonly string[],
    defaults?: Partial<CliArgs>,
  ): CliArgs | undefined {
    return argParser.parseArgs(ArgParser.expandEquals(argv), defaults);
  }

  /**
   * 把 `--flag=value` 展开成 `--flag value`（仅对**已登记的取值型**旗标）。
   *
   * 2026-10-21 修：此前只认精确 token，`--workspace=foo` 会报「未知旗标」退出 1，
   * 而帮助与 `serveWorkspace` 都把它当合法写法。只展开取值型旗标（`VALUE_FLAGS`），
   * 布尔旗标保持原样——`--auto-approve=true` 不该把 `true` 变成 prompt。
   * `--` 之后的 token 一律不展开（显式选项结束符，用于传以 `-` 开头的 prompt）。
   * @param argv 原始参数。
   * @returns 展开后的参数（不修改入参）。
   */
  private static expandEquals(argv: readonly string[]): string[] {
    const out: string[] = [];
    let afterTerminator = false;
    for (const token of argv) {
      if (afterTerminator) {
        out.push(token);
        continue;
      }
      if (token === '--') {
        afterTerminator = true;
        out.push(token);
        continue;
      }
      if (token.startsWith('--') && token.includes('=')) {
        const eq = token.indexOf('=');
        const name = token.slice(0, eq);
        if (VALUE_FLAGS.has(name) && CliFlagTable.isKnownFlag(name)) {
          out.push(name, token.slice(eq + 1));
          continue;
        }
      }
      out.push(token);
    }
    return out;
  }

  /** 配置文件 → CLI 默认参数。 */
  public static configDefaults(file: FileConfig): Partial<CliArgs> {
    return argParser.configDefaults(file);
  }

  /** 打印用法。 */
  public static printUsage(): void {
    argParser.printUsage();
  }

  /** 提取错误消息。 */
  public static messageOf(error: unknown): string {
    return argParser.messageOf(error);
  }

  /** 按适配器反查首个厂商预设（`presets` 可传生效目录以纳入用户覆盖）。 */
  public static adapterToPreset(
    adapter: string,
    presets?: readonly ProviderPreset[],
  ): AdapterPreset | undefined {
    return argParser.adapterToPreset(adapter, presets);
  }

  /** 取适配器下所有厂商预设（`presets` 可传生效目录以纳入用户覆盖）。 */
  public static adapterPresets(
    adapter: string,
    presets?: readonly ProviderPreset[],
  ): readonly AdapterPreset[] {
    return argParser.adapterPresets(adapter, presets);
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const argParser = new ArgParser();
