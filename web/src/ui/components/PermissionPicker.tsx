// 权限档位选择器（替换 Composer 原生的三档下拉）：列出后端 `approval.tiers` 全档，
// 含「完全访问」的警示徽标与高风险说明。点击外部自动收起。
//
// 函数组件范式：展开态与档位表各用一个 useState；档位拉取与外部点击监听各由一个
// 依赖明确的 effect 承接（原实现需手写 componentDidUpdate 比对 prevState）。
// 档位数据由 PermissionTierModel 包装（含离线兜底），组件自身只负责渲染与分派 onPick。

import { React } from '../deps.js';
import { PermissionTierModel } from '../models/PermissionTierModel.js';
import type { ApprovalTier } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

/** PermissionPicker 组件的入参。 */
export interface PermissionPickerProps {
  /** 当前审批枚举值。 */
  permission: string;
  /** 档位切换回调（透传上层 changePermission，已含 config.update 持久化）。 */
  onPick: (v: string) => void;
  /** ApiClient（拉取 approval.tiers；失败回退兜底表）。 */
  api: ApiClient;
  /** 标题（默认「AI 权限等级」）。 */
  title?: string;
}

/**
 * 权限档位选择器：显示当前档位与高风险徽标，展开后列出全部档位及其说明。
 * @param props 组件入参
 * @returns 权限选择器节点
 */
export function PermissionPicker(props: PermissionPickerProps): ReactElement {
  const { permission, onPick, api, title } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  /** 后端下发的档位（未加载时为 undefined → 用兜底表）。 */
  const [tiers, setTiers] = React.useState<readonly ApprovalTier[] | undefined>(undefined);

  // 挂载（或 api 变化）即拉一次档位表；卸载后不再回写（避免无谓的状态更新）。
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

  // 展开期间才挂外部点击监听；收起或卸载即摘除（H3 清理对称）。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  /**
   * 触发按钮：阻断冒泡后切换展开态。
   * @param e 点击事件
   */
  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  };

  /**
   * 菜单容器：阻断冒泡，避免点击菜单内部被误判为「外部点击」。
   * @param e 点击事件
   */
  const stopBubble = (e: MouseEvent): void => {
    e.stopPropagation();
  };

  /**
   * 选中档位：回调上抛后收起。
   * @param v 档位值
   */
  const pick = (v: string): void => {
    onPick(v);
    setOpen(false);
  };

  const model = new PermissionTierModel(tiers);
  const active = model.active(permission);
  const fullAccess = model.isFullAccess(permission);
  return (
    <div
      className={'dd perm' + (fullAccess ? ' danger' : '')}
      title={title ?? 'AI 权限等级'}
      role="button"
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={title ?? 'AI 权限等级'}
      onClick={toggle}
    >
      <span className="dd-ico">🛡</span>
      <span className="dd-label">{active.label}</span>
      {fullAccess ? <span className="perm-badge" title="完全访问：AI 可不受限制地访问你的文件和互联网">⚠</span> : null}
      <span className="dd-caret">▾</span>
      {open ? (
        <div className="dd-menu wide" onClick={stopBubble}>
          {model.all().map((tier) => (
            <div
              key={tier.value}
              className={
                'dd-item perm-item risk-' +
                tier.risk +
                (tier.value === permission ? ' active' : '') +
                (tier.fullAccess ? ' full' : '')
              }
              onClick={() => pick(tier.value)}
            >
              <div className="perm-row">
                <span className="perm-name">{tier.label}</span>
                {tier.fullAccess ? <span className="perm-badge">⚠ 完全访问</span> : null}
              </div>
              <div className="perm-desc">{tier.description}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
