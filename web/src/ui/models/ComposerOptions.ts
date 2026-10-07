// 输入区下拉选项构建：模型清单 / 推理档位。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。
//
// 权限说明**不在这里**（2026-10-07 删除）：它原本在这里再存一份「档位 → 一句话」的映射表，与后端
// `ApprovalTierCatalog`、`PermissionTierModel` 的兜底表构成同一句话的第三份副本。现在悬浮提示
// 直接读档位表的 `description`（见 `PermissionPicker`）。

/** 下拉项。 */
export interface OptionItem {
  value: string;
  label: string;
}

/** 兜底模型候选：服务端 model.catalog 下发当前厂商清单时不再使用；仅作离线回退。 */
const KNOWN_MODELS: readonly string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
  'o3-mini',
  'o4-mini',
  'gpt-4.1',
  'claude-3.5-sonnet',
  'claude-3.7-sonnet',
  'deepseek-chat',
  'deepseek-reasoner',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
];

/** 推理强度兜底档位：model.catalog 未下发 reasoningEffort 时使用。 */
const REASONING_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/** 推理档位中文标签：对服务端下发的未知档位（如 deepseek 的 none/max）也能给出合理标签。 */
const REASONING_LABELS: Readonly<Record<string, string>> = {
  none: '无',
  minimal: '极简',
  low: '弱',
  medium: '中',
  high: '强',
  xhigh: '极强',
  max: '极致',
};

/** 输入区选项构建器。 */
export class ComposerOptions {
  /**
   * 模型候选：只列当前厂商可用清单（服务端下发优先，否则兜底内置清单），
   * 并保证当前值一定在列表里（否则下拉显示空白）。去重且去空。
   */
  public static models(current: string, providerModels?: readonly string[]): string[] {
    const pool = providerModels && providerModels.length > 0 ? providerModels : KNOWN_MODELS;
    return Array.from(new Set([current, ...pool].filter((m) => typeof m === 'string' && m !== '')));
  }

  /**
   * 推理档位：
   * - 服务端下发非空清单 → 用之；
   * - 下发空数组 → 无档位可挑（只留占位项由调用方添加）；
   * - 未下发（undefined）→ 用内置 5 档兜底；
   * 当前值不在清单里时补到最前，防止换厂商后用户已选值丢失。
   */
  public static reasoning(current: string, levels?: readonly string[]): OptionItem[] {
    const pool: readonly string[] = levels !== undefined ? levels : REASONING_LEVELS;
    const seen = new Set<string>();
    const out: OptionItem[] = [];
    for (const v of pool) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push({ value: v, label: REASONING_LABELS[v] ?? v });
    }
    if (current !== '' && !seen.has(current)) {
      out.unshift({ value: current, label: REASONING_LABELS[current] ?? current });
    }
    return out;
  }
}
