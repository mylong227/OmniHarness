// 「全部面板」选择器：截图式三栏壳里右栏不再常驻 12 个功能标签，全部面板收进这个菜单。
// 面板清单来自**注册表**（`models/PanelRegistry.ts`）——与旧 NavRail / 标签条同源，不可能漂移；
// 这里是 12 个面板在桌面端的**唯一**常驻入口（原 NavRail 的职责收编于此）。
//
// 函数组件范式：只一个"菜单展开态"；展开期间才挂外部点击监听（与 NavRail 旧写法同款，不另起一套）。

import { React } from '../deps.js';
import { icon } from '../models/Icon.js';
import { PANELS } from '../models/PanelRegistry.js';

/** PanelPicker 组件的入参。 */
export interface PanelPickerProps {
  /** 当前激活的面板 key（菜单项高亮用）。 */
  activePane: string;
  /** 选中某个面板（上层切换 activePane / 打开右栏）。 */
  onPick: (key: string) => void;
}

/** 菜单弹出坐标（fixed 定位；由按钮实测矩形算出）。 */
interface MenuPos {
  /** 视口内 top（px）。 */
  top: number;
  /** 视口内 right（px，从右缘往左算）。 */
  right: number;
}

/**
 * 「全部面板」选择器：按钮 + 弹出菜单，罗列注册表里全部 12 个面板。
 *
 * 菜单为什么用 `position: fixed`：宿主标签条（`.rv-tabs`）是 `overflow-x:auto` 的滚动容器，
 * `absolute` 弹层会被它整块裁掉（真机实测：菜单开着但完全不可见）。fixed 以**按钮实测矩形**
 * 定位，不受任何裁切祖先影响；展开期间窗口滚动 / 改尺寸即收起（坐标已失效）。
 *
 * @param props 组件入参
 * @returns 选择器节点
 */
export function PanelPicker(props: PanelPickerProps): ReactElement {
  const { activePane, onPick } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  /** 菜单弹出坐标（null = 尚未测量）。 */
  const [pos, setPos] = React.useState<MenuPos | null>(null);
  /** 触发按钮（量它的视口矩形给菜单定位）。 */
  const btnRef = React.useRef<HTMLButtonElement | null>(null);

  // 展开期间才挂外部点击 / 滚动 / 改尺寸监听；收起或卸载即摘除。
  // 滚动要 capture（弹层 fixed 不随容器滚，坐标会漂；任何滚动都直接收起最稳）。
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  /**
   * 点按钮：阻断冒泡后展开（先量按钮矩形再置位，菜单首帧就有正确坐标）。
   * @param e 点击事件
   */
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect !== undefined) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    setOpen((prev) => !prev);
  };

  /**
   * 选一个面板：先收起菜单再上抛。
   * @param key 面板 key
   */
  const pick = (key: string): void => {
    setOpen(false);
    onPick(key);
  };

  return (
    <div className="pp-wrap">
      <button
        ref={btnRef}
        className={'iconbtn pp-btn' + (open ? ' active' : '')}
        title="全部面板"
        aria-label="全部面板"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        onClick={toggle}
      >
        <span aria-hidden="true">{icon('columns', { size: 16 })}</span>
      </button>
      {open ? (
        <div
          className="pp-menu"
          role="menu"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          style={
            pos === null
              ? undefined
              : { position: 'fixed', top: pos.top + 'px', right: pos.right + 'px' }
          }
        >
          <div className="pp-title" aria-hidden="true">
            全部面板
          </div>
          {PANELS.map((p) => (
            <button
              key={p.key}
              className={'pp-item' + (p.key === activePane ? ' active' : '')}
              role="menuitem"
              onClick={() => pick(p.key)}
            >
              <span className="pp-ico" aria-hidden="true">
                {icon(p.icon, { size: 15 })}
              </span>
              <span className="pp-label">{p.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
