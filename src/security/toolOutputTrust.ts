/**
 * 工具输出来源信任级（零依赖，实验性 @beta）。
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
 * - `file`（工作区文件 / 记忆检索），阈值 2；
 * - `local`（本机进程执行输出），阈值 3 —— 日志噪声高，需更强证据才拦。
 *
 * 未登记的工具名一律回落 `unknown`（保守阈值）：**新增外部工具「忘了登记」只会更严、不会更松**。
 */

/** 工具输出来源信任级（越不可信越敏感）。 */
export type TrustTier = 'external' | 'file' | 'local' | 'unknown';

/** 工具输出来源信任级判定器（纯静态，无状态）。 */
export class ToolOutputTrust {
  /** 公网抓取类工具名（内容不在本机可控范围内）。新增外部工具请在此登记。 */
  private static readonly EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
    'web_search',
    'web_fetch',
  ]);

  /** 工作区文件 / 记忆检索类工具名（内容来自本仓库，可信度中）。 */
  private static readonly FILE_TOOLS: ReadonlySet<string> = new Set([
    'read_file',
    'list_dir',
    'memory_search',
    'recall',
    'spill_read',
  ]);

  /** 本机进程执行类工具名（输出即自身命令结果，可信度最高）。 */
  private static readonly LOCAL_TOOLS: ReadonlySet<string> = new Set(['shell', 'run_code']);

  /** 各信任级拦截「弱证据」所需的最低命中数（越低越敏感）。 */
  private static readonly THRESHOLDS: Readonly<Record<TrustTier, number>> = {
    external: 1,
    unknown: 1,
    file: 2,
    local: 3,
  };

  /** 信任级 → 中文标签（可观测 / 审计用）。 */
  private static readonly LABELS: Readonly<Record<TrustTier, string>> = {
    external: '外部抓取',
    unknown: '未知来源',
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
   * @returns 最低弱证据命中数（`external`/`unknown` = 1、`file` = 2、`local` = 3）。
   */
  public static weakEvidenceThreshold(tier: TrustTier): number {
    return ToolOutputTrust.THRESHOLDS[tier];
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
   * 该信任级是否属「不可信」档（弱证据即拦）。
   *
   * @param tier 信任级。
   * @returns `external` / `unknown` 为 true，`file` / `local` 为 false。
   */
  public static isUntrusted(tier: TrustTier): boolean {
    return tier === 'external' || tier === 'unknown';
  }
}
