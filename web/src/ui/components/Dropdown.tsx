// 自定义下拉组件（#UI 主题化）：替代原生 select 的系统弹层——原生 option 列表
// 无法完全主题化（Windows Chrome 高亮色/白底不可控），自绘弹层彻底吃主题变量。
// 向上弹出（用于底部 Composer），点击外部自动收起。
//
// 面向对象改造：展开态从 useState 改为 this.state；外部点击监听按 open 变化挂载 / 摘除。
// 触发按钮 onClick 里 e.stopPropagation() 会同样阻断原生冒泡，故不会「刚开就被外部点击关掉」。

import { React } from '../deps.js';

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownProps {
  title: string;
  icon: string;
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
}

interface DropdownState {
  open: boolean;
}

/** 自绘下拉组件。 */
export class Dropdown extends React.Component<DropdownProps, DropdownState> {
  constructor(props: DropdownProps) {
    super(props);
    this.state = { open: false };
  }

  override componentDidUpdate(_prevProps: DropdownProps, prevState: DropdownState): void {
    const was = prevState.open;
    const now = this.state.open;
    if (was === now) return;
    if (now) window.addEventListener('click', this.close);
    else window.removeEventListener('click', this.close);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('click', this.close);
  }

  /** 外部点击收起（原 useEffect 内的 close）。 */
  private readonly close = (): void => {
    this.setState({ open: false });
  };

  /** 触发按钮：阻断冒泡后切换展开态。 */
  private readonly toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    this.setState((prev) => ({ open: !prev.open }));
  };

  /** 菜单容器：阻断冒泡，避免点击菜单内部被误判为「外部点击」。 */
  private readonly stopBubble = (e: MouseEvent): void => {
    e.stopPropagation();
  };

  /** 选中某项：回调上抛后收起。 */
  private readonly pick = (v: string): void => {
    this.props.onChange(v);
    this.setState({ open: false });
  };

  override render(): ReactElement {
    const { title, icon, value, options } = this.props;
    const { open } = this.state;
    const current = options.find((o) => o.value === value);
    return (
      <div
        className="dd"
        title={title}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={title}
        onClick={this.toggle}
      >
        <span className="dd-ico">{icon}</span>
        <span className="dd-label">{current?.label ?? value ?? ''}</span>
        <span className="dd-caret">▾</span>
        {open ? (
          <div className="dd-menu" onClick={this.stopBubble}>
            {options.map((o) => (
              <div
                key={o.value}
                className={'dd-item' + (o.value === value ? ' active' : '')}
                onClick={() => this.pick(o.value)}
              >
                {o.label}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
}
