// 权限档位模型：后端 `approval.tiers` 的展示层 + 离线兜底。
// 零 React 依赖，node 环境可直接单测。

import type { ApprovalTier } from '../../types/models.js';

/**
 * 离线兜底档位表。
 *
 * 只在 `approval.tiers` 调用失败（服务端未就绪 / 网络抖动）时使用。
 * 文案与后端 `ApprovalTierCatalog` 保持一致——**这里允许重复，但不允许分歧**：
 * 兜底表少一档，用户会以为该档不存在；兜底表自行改写某档语义，则会出现
 * 「界面说完全访问，实际只是按规则放行」这类权限误判。改动任一档时两处必须同步。
 */
export const FALLBACK_APPROVAL_TIERS: readonly ApprovalTier[] = [
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

/** 权限档位模型。 */
export class PermissionTierModel {
  private readonly tiers: readonly ApprovalTier[];

  /**
   * @param tiers 后端下发的档位；为空（未加载 / 加载失败）时使用兜底表
   */
  public constructor(tiers?: readonly ApprovalTier[]) {
    this.tiers = tiers !== undefined && tiers.length > 0 ? tiers : FALLBACK_APPROVAL_TIERS;
  }

  /** 全部档位（顺序即展示顺序）。 */
  public all(): readonly ApprovalTier[] {
    return this.tiers;
  }

  /**
   * 取当前档位。
   * @param value 当前审批枚举值（可能未加载 / 未知）
   * @returns 匹配档位；未知值回退首档（与后端 `ApprovalTierCatalog.of` 同策略）
   */
  public active(value: string): ApprovalTier {
    return this.tiers.find((tier) => tier.value === value) ?? this.tiers[0]!;
  }

  /**
   * 当前是否「完全访问」（UI 显示警示徽标）。
   * @param value 当前审批枚举值
   * @returns 是否放行一切
   */
  public isFullAccess(value: string): boolean {
    return this.active(value).fullAccess;
  }

  /**
   * 输入区 chip 上的文案。
   * @param value 当前审批枚举值
   * @returns 档位展示名
   */
  public chipText(value: string): string {
    return this.active(value).label;
  }
}
