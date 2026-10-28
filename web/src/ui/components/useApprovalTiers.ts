// 档位表的取数 hook（从 PermissionPicker 抽出）。
//
// 一次挂载拉一次 `approval.tiers`，卸载后不再回写；失败保留 `undefined`（由
// `PermissionTierModel` 用兜底表）。抽出来是因为组件体在 2026-10-28 逼近
// `check.mjs` 的函数体上限，而这段 effect 与渲染无关。

import * as React from 'react';
import type { ApprovalTier } from '../../types/models.ts';
import type { ApiClient } from '../../core/ApiClient.ts';

/**
 * 拉取审批档位表。
 * @param api RPC 客户端
 * @returns 档位数组；尚未加载或失败时为 undefined
 */
export function useApprovalTiers(api: ApiClient): readonly ApprovalTier[] | undefined {
  const [tiers, setTiers] = React.useState<readonly ApprovalTier[] | undefined>(undefined);
  React.useEffect(() => {
    let alive = true;
    api
      .approvalTiers()
      .then((r) => {
        if (alive) setTiers(r.tiers);
      })
      .catch(() => {
        /* 失败保留 undefined → 模型用兜底表 */
      });
    return () => {
      alive = false;
    };
  }, [api]);
  return tiers;
}
