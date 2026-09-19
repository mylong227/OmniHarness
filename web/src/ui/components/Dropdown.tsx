// 自定义下拉组件（#UI 主题化）：替代原生 select 的系统弹层——原生 option 列表
// 无法完全主题化（Windows Chrome 高亮色/白底不可控），自绘弹层彻底吃主题变量。
// 向上弹出（用于底部 Composer），点击外部自动收起。
//
// 函数组件范式：展开态用 useState；外部点击监听改由「依赖 open 的 effect 条件挂载 / 清理」承接
// （原实现需要手写 componentDidUpdate 比对 prevState，现在由 deps 语义天然表达）。
// 触发按钮 onClick 里 e.stopPropagation() 会同样阻断原生冒泡，故不会「刚开就被外部点击关掉」。

import { React } from '../deps.js';

/** 下拉项。 */
export interface DropdownOption {
  /** 选项值（回传 onChange）。 */
  value: string;
  /** 选项展示文案。 */
  label: string;
}

/** Dropdown 组件的入参。 */
export interface DropdownProps {
  /** 无障碍标题（同时作 title 属性）。 */
  title: string;
  /** 触发按钮左侧图标。 */
  icon: string;
  /** 当前选中值。 */
  value: string;
  /** 候选项清单。 */
  options: DropdownOption[];
  /** 选中回调。 */
  onChange: (v: string) => void;
}

/**
 * 自绘下拉：点击展开、点击外部收起、选中即回调并收起。
 * @param props 组件入参
 * @returns 下拉节点
 */
export function Dropdown(props: DropdownProps): ReactElement {
  const { title, icon, value, options, onChange } = props;
  const [open, setOpen] = React.useState<boolean>(false);

  // 展开期间才挂外部点击监听；收起或卸载即摘除（H3 清理对称，deps 只有 open）。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  /**
   * 触发按钮：阻断冒泡后切换展开态（阻断后不会立刻被「外部点击」判定关掉）。
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
   * 选中某项：回调上抛后收起。
   * @param v 选项值
   */
  const pick = (v: string): void => {
    onChange(v);
    setOpen(false);
  };

  const current = options.find((o) => o.value === value);
  return (
    <div
      className="dd"
      title={title}
      role="button"
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={title}
      onClick={toggle}
    >
      <span className="dd-ico">{icon}</span>
      <span className="dd-label">{current?.label ?? value ?? ''}</span>
      <span className="dd-caret">▾</span>
      {open ? (
        <div className="dd-menu" onClick={stopBubble}>
          {options.map((o) => (
            <div
              key={o.value}
              className={'dd-item' + (o.value === value ? ' active' : '')}
              onClick={() => pick(o.value)}
            >
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
