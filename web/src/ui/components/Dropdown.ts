// 自定义下拉组件（#UI 主题化）：替代原生 select 的系统弹层——原生 option 列表
// 无法完全主题化（Windows Chrome 高亮色/白底不可控），自绘弹层彻底吃主题变量。
// 向上弹出（用于底部 Composer），点击外部自动收起。

import { html, React } from '../deps.js';

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

export function Dropdown(props: DropdownProps): ReactElement {
  const { title, icon, value, options, onChange } = props;
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);

  React.useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return html`<div
    className="dd"
    title=${title}
    onClick=${(e: Event) => {
      e.stopPropagation();
      setOpen((o) => !o);
    }}
  >
    <span className="dd-ico">${icon}</span>
    <span className="dd-label">${current?.label ?? value ?? ''}</span>
    <span className="dd-caret">▾</span>
    ${open
      ? html`<div
          className="dd-menu"
          onClick=${(e: Event) => e.stopPropagation()}
        >
          ${options.map(
            (o) =>
              html`<div
                key=${o.value}
                className=${'dd-item' + (o.value === value ? ' active' : '')}
                onClick=${() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                ${o.label}
              </div>`,
          )}
        </div>`
      : null}
  </div>`;
}
