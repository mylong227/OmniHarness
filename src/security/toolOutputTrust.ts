/**
 * 工具输出来源信任级（无第三方依赖，实验性 @beta）。
 *
 * 动机：提示注入护栏 `scanForInjection` 原本对一切文本用同一敏感度，产生两个方向的偏差——
 *  ① **外部抓取内容**（`web_search` 结果）是间接提示注入（Indirect Prompt Injection）的主威胁面，
 *     却与本机命令输出同档：弱指令式短语（「If you are an AI agent, …」）一律漏检；
 *  ② **本机命令输出**（`shell`）里的 `system:` / `assistant:` 行是日志常态，却与「角色标记注入」同档，
 *     造成稳定误报。
 *
 * 本类把「内容来源」显式化为信任级，护栏据此**分级敏感**：来源越不可信，拦截所需证据越少（阈值越低）。
 *
 * 分级与阈值（证据 = 弱规则 + 指令式启发式命中数；强规则命中恒拦，与来源无关）：
 * - `external`（公网抓取），阈值 1 —— 内容不在本机可控范围，弱证据即隔离；
 * - `unknown`（未登记工具），阈值 1 —— 与 external 同档，**宁可多拦**（fail-closed）；
 * - `memory`（**记忆检索**），阈值 1 —— 见下节"为什么记忆与 external 同档"；
 * - `file`（工作区文件），阈值 2；
 * - `local`（本机进程执行输出），阈值 3 —— 日志噪声高，需更强证据才拦。
 *
 * ## 为什么记忆与 external 同档（2026-10-03 第六轮 G5 收紧）
 *
 * 原先 `memory_search` / `recall` 与 `read_file` 同归 `file` 档（阈值 2）。这低估了两件事：
 *  1. **持久性放大**：工作区文件是"读一次、用完即过"，而记忆是**跨会话持久**的——一次注入若能写进
 *     长期记忆，之后每次召回都会把它带回来。持久化的注入面比一次性抓取更危险，不是更安全。
 *  2. **来源混合、不可追溯**：记忆条目由抽取器从历史对话里总结，其原始来源可能是公网抓取
 *     （`web_search` / `web_fetch` 的产物）；召回时**无法区分**"用户亲口说的"与"从外部网页读来的"。
 *     既然无法证明可信，按本模块既定原则（"无法登记即更严"）应取更严的阈值。
 * 故记忆单列 `memory` 档、阈值 1（与 `external` 同级）；需要放宽时可经
 * `promptInjectionGuardThresholds` 显式覆盖（**放宽必须显式**，不得靠默认值）。
 *
 * 未登记的工具名一律回落 `unknown`（保守阈值）：**新增外部工具「忘了登记」只会更严、不会更松**。
 *
 * 工具名来自 `ports/tool/toolNames.ts`（单一来源）；本模块在 `security/`，故另需 `ports/` 与 `util/`
 * 两个公共层依赖（见 `ARCHITECTURE_SPEC.md` §2 的目录归属表）。
 */
import { TOOL_NAMES } from '../ports/tool/toolNames.js';

/** 工具输出来源信任级（越不可信越敏感）。 */
export type TrustTier = 'external' | 'file' | 'local' | 'memory' | 'unknown';

/** 工具输出来源信任级判定器（纯静态，无状态）。 */
export class ToolOutputTrust {
  /** 公网抓取类工具名（内容不在本机可控范围内）。新增外部工具请在此登记。 */
  private static readonly EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
    TOOL_NAMES.webSearch,
    TOOL_NAMES.webFetch,
  ]);

  /**
   * 记忆检索类工具名（**跨会话持久 + 来源不可追溯** ⇒ 与 `external` 同档，阈值 1）。
   *
   * 注意 `remember` 之类的**写入**工具不在此列：它们不把内容带进上下文，威胁面在召回侧。
   */
  private static readonly MEMORY_TOOLS: ReadonlySet<string> = new Set([
    TOOL_NAMES.memorySearch,
    TOOL_NAMES.recall,
  ]);

  /** 工作区文件类工具名（内容来自本仓库，可信度中）。 */
  private static readonly FILE_TOOLS: ReadonlySet<string> = new Set([
    TOOL_NAMES.readFile,
    TOOL_NAMES.listDir,
    TOOL_NAMES.spillRead,
  ]);

  /** 本机进程执行类工具名（输出即自身命令结果，可信度最高）。 */
  private static readonly LOCAL_TOOLS: ReadonlySet<string> = new Set([
    TOOL_NAMES.shell,
    TOOL_NAMES.runCode,
  ]);

  /** 各信任级拦截「弱证据」所需的最低命中数（越低越敏感，基线；可被 `setThresholdOverride` 覆盖）。 */
  private static readonly THRESHOLDS: Readonly<Record<TrustTier, number>> = {
    external: 1,
    unknown: 1,
    // G5 收紧：记忆跨会话持久、来源不可追溯 ⇒ 与 external 同档（理由见类头 JSDoc）。
    memory: 1,
    file: 2,
    local: 3,
  };

  /** 运行期阈值覆盖（部分覆盖；未给的档沿用 `THRESHOLDS` 基线）。由装配层在构造注入护栏时设置。 */
  private static thresholdOverride: Partial<Record<TrustTier, number>> = {};

  /**
   * 覆盖各信任级的弱证据阈值（部分覆盖，未给的档沿用基线）。
   *
   * @param override 信任级 → 新阈值 的部分映射（值须为正整数）。传 `{}` 即清除覆盖。
   * @returns 无返回值。
   */
  public static setThresholdOverride(override: Readonly<Partial<Record<TrustTier, number>>>): void {
    ToolOutputTrust.thresholdOverride = { ...override };
  }

  /**
   * 清除运行期阈值覆盖，回到内置基线。测试可调用以隔离副作用。
   *
   * @returns 无返回值。
   */
  public static resetThresholdOverride(): void {
    ToolOutputTrust.thresholdOverride = {};
  }

  /** 信任级 → 中文标签（可观测 / 审计用）。 */
  private static readonly LABELS: Readonly<Record<TrustTier, string>> = {
    external: '外部抓取',
    unknown: '未知来源',
    memory: '长期记忆',
    file: '文件内容',
    local: '本机命令',
  };

  /**
   * 由工具名推断来源信任级（大小写不敏感、首尾空白已裁）。
   *
   * @param toolName 工具名（如 `web_search` / `read_file` / `shell`）。
   * @returns 信任级；未登记的工具名回落 `unknown`（保守阈值）。
   */
  public static fromToolName(toolName: string): TrustTier {
    const name = toolName.trim().toLowerCase();
    if (ToolOutputTrust.EXTERNAL_TOOLS.has(name)) {
      return 'external';
    }
    // 记忆必须先于 file 判定：本档的存在意义就是"不与工作区文件同档"。
    if (ToolOutputTrust.MEMORY_TOOLS.has(name)) {
      return 'memory';
    }
    if (ToolOutputTrust.FILE_TOOLS.has(name)) {
      return 'file';
    }
    if (ToolOutputTrust.LOCAL_TOOLS.has(name)) {
      return 'local';
    }
    return 'unknown';
  }

  /**
   * 该信任级拦截「弱证据」所需的最低命中数。
   *
   * @param tier 信任级。
   * @returns 最低弱证据命中数（`external`/`unknown`/`memory` = 1、`file` = 2、`local` = 3）。
   */
  public static weakEvidenceThreshold(tier: TrustTier): number {
    const o = ToolOutputTrust.thresholdOverride[tier];
    return o === undefined ? ToolOutputTrust.THRESHOLDS[tier] : o;
  }

  /**
   * 信任级的中文标签（可观测 / 审计）。
   *
   * @param tier 信任级。
   * @returns 中文标签（如 `external` → `外部抓取`）。
   */
  public static labelOf(tier: TrustTier): string {
    return ToolOutputTrust.LABELS[tier];
  }

  /**
   * 各信任级的**生效**弱证据阈值快照（含运行期覆盖）。
   *
   * 存在理由（G5）：诊断输出（`doctor`）需要如实转述"当前实际的敏感性配置"，而信任级联合类型在运行期
   * 不可枚举；由此处集中给出，避免诊断侧另抄一份阈值表而两处漂移。
   * @returns 信任级 → 生效阈值（已应用覆盖）。
   */
  public static thresholds(): Readonly<Record<TrustTier, number>> {
    return {
      external: ToolOutputTrust.weakEvidenceThreshold('external'),
      unknown: ToolOutputTrust.weakEvidenceThreshold('unknown'),
      memory: ToolOutputTrust.weakEvidenceThreshold('memory'),
      file: ToolOutputTrust.weakEvidenceThreshold('file'),
      local: ToolOutputTrust.weakEvidenceThreshold('local'),
    };
  }

  /**
   * 该信任级是否属「不可信」档（弱证据即拦）。
   *
   * 判据与阈值**同源**：阈值 1 即"弱证据即拦"⇒ 不可信档。这样新增档位时不会出现
   * "阈值已收紧、`isUntrusted` 却说它可信"的声明/实现分叉。
   *
   * @param tier 信任级。
   * @returns `external` / `unknown` / `memory` 为 true，`file` / `local` 为 false。
   */
  public static isUntrusted(tier: TrustTier): boolean {
    return ToolOutputTrust.weakEvidenceThreshold(tier) <= 1;
  }
}
