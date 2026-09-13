/**
 * 审批档位目录：审批等级的唯一事实源（后端定语义，UI 只做展示）。
 *
 * 为什么必须由后端下发：档位直接决定「模型能不能改你的文件、能不能联网」。
 * 如果前端自造一份文案与顺序，后端加了档位（或改了某档的放行范围）时，
 * 用户界面会继续用旧描述解释新行为——这类不一致在权限场景里是安全事故级的。
 * 因此 UI 一律通过 `approval.tiers` 取档位；前端只保留一份离线兜底拷贝。
 *
 * 档位与后端解析的对应关系（见 `AgentRuntimeHost.resolveApprovals`）：
 *  - `ask`   → 上行审批端口：每次工具调用都发 `approval.request` 等用户点确认；
 *  - `rules` → 规则审批：只读类工具放行，危险操作（rm/del 等）拒绝，其余按 `--approval-ask`；
 *  - `auto`  → 全部放行（**风险最高**：等同于把工作区与网络交给模型自行处置）；
 *  - `plan`  → 规划模式：只读白名单，写类工具一律拒绝（用于「先出方案」）；
 *  - `deny`  → 全部拒绝：模型可用但任何工具调用都不会被执行（纯对话）。
 */

/** 审批档位的风险级别（UI 据此决定是否显示警示色/徽标）。 */
export type ApprovalRisk = 'low' | 'medium' | 'high';

/** 单个审批档位。 */
export interface ApprovalTier {
  /** 后端枚举值（`config.update({ approval })` 直接可用）。 */
  readonly value: string;
  /** 展示名。 */
  readonly label: string;
  /** 一句话说明「这一档实际会发生什么」。 */
  readonly description: string;
  /** 风险级别。 */
  readonly risk: ApprovalRisk;
  /** 是否为「放行一切」档（UI 显示「完全访问」警示徽标）。 */
  readonly fullAccess: boolean;
}

/** 审批档位目录。 */
export class ApprovalTierCatalog {
  /** 档位目录数据（顺序即 UI 展示顺序：安全档在前，`auto` 置于末位前置警示位）。 */
  private readonly tiers: readonly ApprovalTier[] = [
    {
      value: 'rules',
      label: '默认',
      description: '按规则自动放行安全操作；删除等危险命令仍会拒绝',
      risk: 'low',
      fullAccess: false,
    },
    {
      value: 'ask',
      label: '请求批准',
      description: '编辑外部文件和使用互联网时始终询问',
      risk: 'low',
      fullAccess: false,
    },
    {
      value: 'plan',
      label: '计划模式',
      description: '只读规划：仅放行读取与检索类工具，不动工作区',
      risk: 'low',
      fullAccess: false,
    },
    {
      value: 'auto',
      label: '完全访问',
      description: '可不受限制地访问互联网和你电脑上的任何文件',
      risk: 'high',
      fullAccess: true,
    },
    {
      value: 'deny',
      label: '全部拒绝',
      description: '拒绝一切工具调用（模型只对话，不产生任何副作用）',
      risk: 'low',
      fullAccess: false,
    },
  ];

  /**
   * 全部档位（顺序即 UI 展示顺序：安全档在前，`auto` 置于末位前置警示位）。
   * @returns 档位数组（只读）
   */
  public all(): readonly ApprovalTier[] {
    return this.tiers;
  }

  /**
   * 按枚举值取档位。
   * @param value 后端枚举值（可能是未知值 / 空串）
   * @returns 匹配档位；未知值回退「默认」档（fail-soft：UI 不至于因一个脏配置整个权限区空白）
   */
  public of(value: string | undefined): ApprovalTier {
    return this.tiers.find((tier) => tier.value === value) ?? this.tiers[0]!;
  }

  /**
   * 该值是否为「完全访问」（UI 显示警示徽标的判据）。
   * @param value 后端枚举值
   * @returns 是否放行一切
   */
  public isFullAccess(value: string | undefined): boolean {
    return this.of(value).fullAccess;
  }
}
