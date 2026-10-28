// 权限档位选择器（替换 Composer 原生的三档下拉）：列出后端 `approval.tiers` 全档，
// 高危档在菜单里带「完全访问」徽标与风险说明；收起态保持单层 chip（2026-10-27 用户
// 「不要套两层太占地方」——fullAccess 档名本身就是「完全访问」，不再套同文案徽标）。
// 点击外部自动收起。
//
// 函数组件范式：展开态与档位表各用一个 useState；档位拉取与外部点击监听各由一个
// 依赖明确的 effect 承接（原实现需手写 componentDidUpdate 比对 prevState）。
// 档位数据由 PermissionTierModel 包装（含离线兜底），组件自身只负责渲染与分派 onPick。
//
// 2026-10-28：菜单键盘导航（roving tabindex + ↑/↓）抽到 `useMenuNavigation`；单项渲染抽到
// `PermissionTierOption`（组件体已逼近 `check.mjs` 的函数体上限）。

import * as React from 'react';
import { PermissionTierModel } from '../models/PermissionTierModel.ts';
import { claimPopover, releasePopover } from '../models/PopoverStack.ts';
import { ActivationKeys } from '../models/ActivationKeys.ts';
import { MenuFocusModel } from '../models/MenuFocusModel.ts';
import { usePopoverEffect } from './usePopoverEffect.ts';
import { useMenuNavigation } from './useMenuNavigation.ts';
import { useApprovalTiers } from './useApprovalTiers.ts';
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

/** 单个档位项。 */
interface PermissionTierOptionProps {
  /** 档位数据。 */
  readonly tier: ApprovalTier;
  /** 是否为当前档位。 */
  readonly selected: boolean;
  /** 在菜单里的位置（roving tabindex 用）。 */
  readonly index: number;
  /** 当前活动项下标。 */
  readonly activeItem: number;
  /** 选中回调。 */
  readonly onPick: (value: string) => void;
  /** 聚焦某项时同步活动下标。 */
  readonly onFocusItem: (index: number) => void;
}

/**
 * 一个档位项：徽标 / 名称 / 说明 + 键盘激活。
 * @param props 档位与回调
 * @returns 档位项节点
 */
function PermissionTierOption(props: PermissionTierOptionProps): ReactElement {
  const { tier, selected, index, activeItem, onPick, onFocusItem } = props;
  return (
    <div
      className={
        'dd-item perm-item risk-' +
        tier.risk +
        (selected ? ' active' : '') +
        (tier.fullAccess ? ' full' : '')
      }
      role="option"
      aria-selected={selected ? 'true' : 'false'}
      data-menu-item
      tabIndex={MenuFocusModel.tabIndexFor(index, activeItem)}
      onFocus={() => onFocusItem(index)}
      onClick={() => onPick(tier.value)}
      onKeyDown={(e: React.KeyboardEvent) => {
        ActivationKeys.activate(e, () => onPick(tier.value));
      }}
    >
      <div className="perm-row">
        <span className="perm-name">{t(tier.label)}</span>
        {tier.fullAccess ? (
          <span className="perm-badge">
            {icon('alert', { size: 11 })} {t('完全访问')}
          </span>
        ) : null}
      </div>
      <div className="perm-desc">{t(tier.description)}</div>
    </div>
  );
}

/** 档位菜单（listbox + 逐项）。 */
interface PermissionMenuProps {
  /** 全部档位。 */
  readonly tiers: readonly ApprovalTier[];
  /** 当前档位值（决定 aria-selected）。 */
  readonly permission: string;
  /** 可访问名（与触发器同一标题）。 */
  readonly label: string;
  /** 当前活动项下标。 */
  readonly activeItem: number;
  /** 菜单键盘处理（来自 useMenuNavigation）。 */
  readonly onMenuKeyDown: (e: React.KeyboardEvent) => void;
  /** 菜单容器 ref。 */
  readonly menuRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 聚焦某项时同步活动下标。 */
  readonly onFocusItem: (index: number) => void;
  /** 选中回调。 */
  readonly onPick: (value: string) => void;
  /** 阻断冒泡（避免被判定为外部点击）。 */
  readonly stopBubble: (e: React.MouseEvent) => void;
}

/**
 * 档位菜单：`listbox` + 逐项（键盘导航由父组件注入）。
 * @param props 档位与回调
 * @returns 菜单节点
 */
function PermissionMenu(props: PermissionMenuProps): ReactElement {
  const { tiers, permission, label, activeItem, onMenuKeyDown, menuRef, onFocusItem, onPick, stopBubble } =
    props;
  return (
    <div
      className="dd-menu wide"
      role="listbox"
      aria-label={label}
      onClick={stopBubble}
      onKeyDown={onMenuKeyDown}
      ref={(el: HTMLDivElement | null) => {
        menuRef.current = el;
      }}
    >
      {tiers.map((tier, index) => (
        <PermissionTierOption
          key={tier.value}
          tier={tier}
          selected={tier.value === permission}
          index={index}
          activeItem={activeItem}
          onPick={onPick}
          onFocusItem={onFocusItem}
        />
      ))}
    </div>
  );
}

/** 触发器 chip（收起态一行）。 */
interface PermissionTriggerProps {
  /** 悬浮提示（同时充当可访问名）。 */
  readonly tooltip: string;
  /** 当前档位文案。 */
  readonly label: string;
  /** 是否完全访问（决定 danger 配色与盾牌换警示）。 */
  readonly fullAccess: boolean;
  /** 展开态。 */
  readonly open: boolean;
  /** 点击。 */
  readonly onToggle: (e: React.MouseEvent) => void;
  /** 键盘。 */
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
  /** 触发器 ref（Esc 收起后归还焦点）。 */
  readonly triggerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** 展开时的菜单内容。 */
  readonly children: React.ReactNode;
}

/**
 * 权限触发器：单层 chip（图标 + 档位 + 箭头）+ 展开时的菜单。
 * @param props 触发器属性与菜单内容
 * @returns 触发器节点
 */
function PermissionTrigger(props: PermissionTriggerProps): ReactElement {
  const { tooltip, label, fullAccess, open, onToggle, onKeyDown, triggerRef, children } = props;
  return (
    <div
      className={'dd perm' + (fullAccess ? ' danger' : '')}
      title={tooltip}
      role="button"
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={tooltip}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      tabIndex={0}
      ref={(el: HTMLDivElement | null) => {
        triggerRef.current = el;
      }}
    >
      <span className="dd-ico">{icon(fullAccess ? 'alert' : 'shield', { size: 14 })}</span>
      <span className="dd-label">{label}</span>
      <span className="dd-caret">▾</span>
      {children}
    </div>
  );
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
  const tiers = useApprovalTiers(api);
  /** 触发器引用（Esc 收起后把焦点还给它）。 */
  const triggerRef = React.useRef<HTMLDivElement | null>(null);

  // 展开期间才挂外部点击监听；收起或卸载即摘除（H3 清理对称）。互斥登记交由同一 hook。
  usePopoverEffect(open, () => setOpen(false), POPOVER_ID);

  /** 收起（释放互斥）并把焦点还给触发器。 */
  const closeAndReturnFocus = (): void => {
    releasePopover(POPOVER_ID);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // 菜单键盘导航（roving tabindex + ↑/↓/Home/End）：与模型菜单同一套实现。
  const menu = useMenuNavigation({
    onEscape: closeAndReturnFocus,
    ensureOpen: () => {
      if (!open) flip();
    },
  });

  /**
   * 切换展开态（点击与键盘共用；打开时登记互斥，收起时释放）。
   * @returns 无
   */
  const flip = (): void => {
    const next = !open;
    if (next) {
      claimPopover({ id: POPOVER_ID, close: () => setOpen(false) });
      menu.setActiveItem(0);
    } else {
      releasePopover(POPOVER_ID);
    }
    setOpen(next);
  };

  /**
   * 触发按钮：阻断冒泡后切换展开态。
   *
   * 打开前 claim 一次：`stopPropagation` 让全局 click 关不掉**别人**，
   * 若不主动顶掉，先开的「+」菜单会继续留在屏幕上并被我压住（用户实测到的重叠）。
   * @param e 点击事件
   */
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    flip();
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
  // 收起态也**不再追加「完全访问」警示徽标**（2026-10-27 用户：「不要套两层太占地方」）：
  // fullAccess 档的 label 本身就是「完全访问」，再套一层同文案徽标纯属重复；警示改由
  // danger 配色（`.composer .dd.perm.danger`）+ 盾牌换警示图标承担，完整风险说明仍在悬浮提示里。
  const baseTitle = title ?? t('AI 权限等级');
  const tip = t('{title}｜{label}：{desc}', {
    title: baseTitle,
    label: t(active.label),
    desc: t(active.description),
  });
  /** 触发器的键盘处理：Esc 收起；Enter/Space 切换；↑/↓ 展开并落到首/末项。 */
  const onTriggerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      releasePopover(POPOVER_ID);
      setOpen(false);
      return;
    }
    if (ActivationKeys.activate(e, flip)) {
      e.stopPropagation();
      return;
    }
    menu.onTriggerKey(e);
  };
  return (
    <PermissionTrigger
      tooltip={tip}
      label={active.label}
      fullAccess={fullAccess}
      open={open}
      onToggle={toggle}
      onKeyDown={onTriggerKeyDown}
      triggerRef={triggerRef}
    >
      {open ? (
        <PermissionMenu
          tiers={model.all()}
          permission={permission}
          label={baseTitle}
          activeItem={menu.activeItem}
          onMenuKeyDown={menu.onMenuKeyDown}
          menuRef={menu.menuRef}
          onFocusItem={menu.setActiveItem}
          onPick={pick}
          stopBubble={stopBubble}
        />
      ) : null}
    </PermissionTrigger>
  );
}
