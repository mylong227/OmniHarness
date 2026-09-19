// 工作状态条：回合进行中显示动画 + 当前动作 + 已耗时，让「看不见的等待」变成「看得见的干活」。
// 函数组件范式：计时起点用 useRef，周期刷新用 useState + 空依赖 effect（清理函数对称清掉 interval）。

import { React } from '../deps.js';

/** WorkIndicator 组件的入参。 */
export interface WorkIndicatorProps {
  /** 当前正在调用的工具名；为 null 表示尚未进入工具阶段（展示「思考中」）。 */
  activeTool: string | null;
}

/** 计时刷新间隔（ms）。 */
const TICK_MS = 1000;

/**
 * 工作状态条：渲染动作文案与已耗时秒数。
 * @param props 组件入参
 * @returns 状态条节点
 */
export function WorkIndicator(props: WorkIndicatorProps): ReactElement {
  const { activeTool } = props;
  const [elapsed, setElapsed] = React.useState<number>(0);
  const startedAtRef = React.useRef<number>(0);

  // 挂载即起表、卸载即停表（[] 有意：计时与 props 无关，只跑一次）。
  React.useEffect(() => {
    startedAtRef.current = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, []);

  const action = activeTool != null ? '正在调用 ' + activeTool : '思考中';
  // role=status：忙碌态是异步状态变化，让辅助技术播报「在干什么」；
  // 每秒跳动的计时数字对朗读无信息量，故 aria-hidden 掉，避免每秒打断一次。
  return (
    <div className="work-indicator" role="status" aria-live="polite">
      <span className="wi-dot" aria-hidden="true"></span>
      <span className="wi-text">{action}</span>
      <span className="wi-time" aria-hidden="true">{elapsed >= 1 ? elapsed + 's' : '刚刚'}</span>
    </div>
  );
}
