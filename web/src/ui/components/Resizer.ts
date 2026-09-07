// 可拖拽分隔条：调整相邻面板的宽度，并把结果持久化到 localStorage。

import { html, React } from '../deps.js';

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

export function Resizer(props: ResizerProps): ReactElement {
  const { side, width, onChange, min = 180, max = 600 } = props;
  const dragging = React.useRef(false);
  const startX = React.useRef(0);
  const startWidth = React.useRef(width);

  const onMouseDown = React.useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = side === 'left' ? e.clientX - startX.current : startX.current - e.clientX;
      const next = Math.min(max, Math.max(min, startWidth.current + delta));
      onChange(next);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [side, min, max, onChange]);

  return html`<div className="resizer" title="拖拽调整宽度" onMouseDown=${onMouseDown} />`;
}
