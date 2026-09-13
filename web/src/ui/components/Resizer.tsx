// 可拖拽分隔条：调整相邻面板的宽度，并把结果持久化到 localStorage。
//
// 面向对象改造：拖拽状态从 useRef 改为实例字段；window 监听在 componentDidMount 挂一次、
// componentWillUnmount 摘掉（handler 内部读 this.props，故 props 变化无需重挂监听）。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';

export interface ResizerProps {
  /** 该 resizer 控制的是哪一侧：left=左侧面板，right=右侧面板。 */
  side: 'left' | 'right';
  /** 当前面板宽度（px）。 */
  width: number;
  /** 宽度变化回调。 */
  onChange: (width: number) => void;
  /** 最小宽度（px）。 */
  min?: number;
  /** 最大宽度（px）。 */
  max?: number;
}

/** 可拖拽分隔条组件。 */
export class Resizer extends AppComponent<ResizerProps> {
  /** 是否处于拖拽中（原 useRef(false)）。 */
  private dragging = false;
  /** 拖拽起始鼠标 X（原 useRef(0)）。 */
  private startX = 0;
  /** 拖拽起始宽度（原 useRef(width)）。 */
  private startWidth = 0;

  override componentDidMount(): void {
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.restoreCursor();
  }

  /** 恢复被拖拽期间改写的 body 样式（卸载时兜底，避免光标卡住）。 */
  private restoreCursor(): void {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this.dragging = true;
    this.startX = e.clientX;
    this.startWidth = this.props.width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return;
    const { side, onChange, min = 180, max = 600 } = this.props;
    const delta = side === 'left' ? e.clientX - this.startX : this.startX - e.clientX;
    const next = Math.min(max, Math.max(min, this.startWidth + delta));
    onChange(next);
  };

  private readonly onMouseUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.restoreCursor();
  };

  override render(): ReactElement {
    return <div className="resizer" title="拖拽调整宽度" onMouseDown={this.onMouseDown} />;
  }
}
