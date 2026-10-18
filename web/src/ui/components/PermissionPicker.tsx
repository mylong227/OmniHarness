// 权限档位选择器（替换 Composer 原生的三档下拉）：列出后端 `approval.tiers` 全档，
// 含「完全访问」的警示徽标与高风险说明。点击外部自动收起。
//
// 函数组件范式：展开态与档位表各用一个 useState；档位拉取与外部点击监听各由一个
// 依赖明确的 effect 承接（原实现需手写 componentDidUpdate 比对 prevState）。
// 档位数据由 PermissionTierModel 包装（含离线兜底），组件自身只负责渲染与分派 onPick。

import * as React from 'react';
import { PermissionTierModel } from '../models/PermissionTierModel.ts';
import { claimPopover, releasePopover } from '../models/PopoverStack.ts';
import { usePopoverEffect } from './usePopoverEffect.ts';
import { icon } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';
import type { ApprovalTier } from '../../types/models.ts';
import type { ApiClient } from '../../core/ApiClient.ts';

/** 本弹层在互斥控制器里的身份。 */
const POPOVER_ID = 'permission';

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

  // 展开期间才挂外部点击监听；收起或卸载即摘除（H3 清理对称）。互斥登记交由同一 hook。
  usePopoverEffect(open, () => setOpen(false), POPOVER_ID);

  /**
   * 触发按钮：阻断冒泡后切换展开态。
   *
   * 打开前 claim 一次：`stopPropagation` 让全局 click 关不掉**别人**，
   * 若不主动顶掉，先开的「+」菜单会继续留在屏幕上并被我压住（用户实测到的重叠）。
   * @param e 点击事件
   */
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const next = !open;
    if (next) claimPopover({ id: POPOVER_ID, close: () => setOpen(false) });
    else releasePopover(POPOVER_ID);
    setOpen(next);
  };

  /**
   * 菜单容器：阻断冒泡，避免点击菜单内部被误判为「外部点击」。
   * @param e 点击事件
   */
  const stopBubble = (e: React.MouseEvent): void => {
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
  // 档位说明只走**悬浮提示**，不常驻占输入区版面（2026-10-07 用户：「进行简单文字描述或者去掉，
  // 进行悬浮冒泡提示即可，不要占地方」）。说明文字取档位表自身的 description——它与后端
  // `ApprovalTierCatalog` 同源，不再另存一份提示表（旧 `ComposerOptions.permissionHint` 已删：
  // 同一句权限说明存三处是这个仓库最容易漂的地方）。
  const baseTitle = title ?? t('AI 权限等级');
  const tip = t('{title}｜{label}：{desc}', { title: baseTitle, label: t(active.label), desc: t(active.description) });
  return (
    <div
      className={'dd perm' + (fullAccess ? ' danger' : '')}
      title={tip}
      role="button"
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={tip}
      onClick={toggle}
    >
      <span className="dd-ico">{icon('shield', { size: 14 })}</span>
      <span className="dd-label">{active.label}</span>
      {fullAccess ? (
        <span
          className="perm-badge"
          title={t('完全访问：AI 可不受限制地访问你的文件和互联网')}
        >
          {icon('alert', { size: 12 })} {t('完全访问')}
        </span>
      ) : null}
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
                <span className="perm-name">{t(tier.label)}</span>
                {tier.fullAccess ? (
                  <span className="perm-badge">{icon('alert', { size: 11 })} {t('完全访问')}</span>
                ) : null}
              </div>
              <div className="perm-desc">{t(tier.description)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
