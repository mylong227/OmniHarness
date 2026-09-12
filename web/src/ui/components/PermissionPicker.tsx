// 权限档位选择器（替换 Composer 原生的三档下拉）：列出后端 `approval.tiers` 全档，
// 含「完全访问」的警示徽标与高风险说明。点击外部自动收起。
//
// 面向对象：展开态用 this.state；档位数据由 PermissionTierModel 包装（含离线兜底），
// 组件自身只负责渲染与分派 onPick。

import { React } from '../deps.js';
import { PermissionTierModel } from '../models/PermissionTierModel.js';
import type { ApprovalTier } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

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

interface PermissionPickerState {
  open: boolean;
  /** 后端下发的档位（未加载时为 undefined → 用兜底表）。 */
  tiers?: readonly ApprovalTier[];
}

/** 权限档位选择器组件。 */
export class PermissionPicker extends React.Component<PermissionPickerProps, PermissionPickerState> {
  constructor(props: PermissionPickerProps) {
    super(props);
    this.state = { open: false, tiers: undefined };
  }

  override componentDidMount(): void {
    // 进页面即拉一次档位表，保证「完全访问」警示徽标文案与后端一致。
    this.props.api
      .approvalTiers()
      .then((r) => this.setState({ tiers: r.tiers }))
      .catch(() => {
        /* 失败保留 undefined → 模型用兜底表 */
      });
  }

  override componentDidUpdate(_prev: PermissionPickerProps, prev: PermissionPickerState): void {
    if (prev.open === this.state.open) return;
    if (this.state.open) window.addEventListener('click', this.close);
    else window.removeEventListener('click', this.close);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('click', this.close);
  }

  private readonly close = (): void => {
    this.setState({ open: false });
  };

  private readonly toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    this.setState((prev) => ({ open: !prev.open }));
  };

  private readonly stopBubble = (e: MouseEvent): void => {
    e.stopPropagation();
  };

  private readonly pick = (v: string): void => {
    this.props.onPick(v);
    this.setState({ open: false });
  };

  override render(): ReactElement {
    const { permission, title } = this.props;
    const { open, tiers } = this.state;
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
        onClick={this.toggle}
      >
        <span className="dd-ico">🛡</span>
        <span className="dd-label">{active.label}</span>
        {fullAccess ? <span className="perm-badge" title="完全访问：AI 可不受限制地访问你的文件和互联网">⚠</span> : null}
        <span className="dd-caret">▾</span>
        {open ? (
          <div className="dd-menu wide" onClick={this.stopBubble}>
            {model.all().map((tier) => (
              <div
                key={tier.value}
                className={
                  'dd-item perm-item risk-' +
                  tier.risk +
                  (tier.value === permission ? ' active' : '') +
                  (tier.fullAccess ? ' full' : '')
                }
                onClick={() => this.pick(tier.value)}
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
}
