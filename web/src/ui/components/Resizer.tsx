// 可拖拽分隔条：调整相邻面板的宽度，并把结果持久化到 localStorage。
//
// 函数组件范式：拖拽中间态（dragging / startX / startWidth）用 useRef（不触发渲染）；
// window 监听在空依赖 effect 里挂一次、清理函数里摘掉；handler 经「最新值 ref」读取 props，
// 既避免每次 props 变化重挂监听，也不受陈旧闭包影响（H5）。

import { React } from '../deps.js';

/** Resizer 组件的入参。 */
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

/** 恢复被拖拽期间改写的 body 样式（卸载或抬起时兜底，避免光标卡住）。 */
function restoreCursor(): void {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

/**
 * 可拖拽分隔条：按下记录起点，移动时按侧别换算宽度并回调，抬起收尾。
 * @param props 组件入参
 * @returns 分隔条节点
 */
export function Resizer(props: ResizerProps): ReactElement {
  const { side, width, onChange, min = 180, max = 600 } = props;
  const draggingRef = React.useRef<boolean>(false);
  const startXRef = React.useRef<number>(0);
  const startWidthRef = React.useRef<number>(0);
  // 最新值镜像：window handler 只挂一次，但每次都能读到本渲染的 props。
  const latestRef = React.useRef({ side, width, onChange, min, max });
  latestRef.current = { side, width, onChange, min, max };

  // 窗口级监听只挂一次（[] 是有意的：handler 经 ref 取最新值，不依赖 props 引用）。
  React.useEffect(() => {
    /** 拖拽中：按侧别换算宽度并夹在 [min, max] 内。 */
    const onMouseMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      const cur = latestRef.current;
      const delta = cur.side === 'left' ? e.clientX - startXRef.current : startXRef.current - e.clientX;
      const next = Math.min(cur.max, Math.max(cur.min, startWidthRef.current + delta));
      cur.onChange(next);
    };
    /** 抬起：结束拖拽并恢复光标。 */
    const onMouseUp = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      restoreCursor();
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      restoreCursor();
    };
  }, []);

  /**
   * 按下：记录拖拽起点与起始宽度，并改光标为列宽调整态。
   * @param e 鼠标按下事件
   */
  const onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return <div className="resizer" title="拖拽调整宽度" onMouseDown={onMouseDown} />;
}
