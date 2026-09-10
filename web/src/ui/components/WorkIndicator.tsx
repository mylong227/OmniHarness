// 工作状态条：回合进行中显示动画 + 当前动作 + 已耗时，让「看不见的等待」变成「看得见的干活」。

import { React } from '../deps.js';

export interface WorkIndicatorProps {
  activeTool: string | null;
}

interface WorkIndicatorState {
  /** 已耗时（秒）。 */
  elapsed: number;
}

/** 计时刷新间隔（ms）。 */
const TICK_MS = 1000;

/** 工作状态条组件。 */
export class WorkIndicator extends React.Component<WorkIndicatorProps, WorkIndicatorState> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(props: WorkIndicatorProps) {
    super(props);
    this.state = { elapsed: 0 };
  }

  override componentDidMount(): void {
    this.startedAt = Date.now();
    this.timer = setInterval(
      () => this.setState({ elapsed: Math.floor((Date.now() - this.startedAt) / 1000) }),
      TICK_MS,
    );
  }

  override componentWillUnmount(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  override render(): ReactElement {
    const { activeTool } = this.props;
    const { elapsed } = this.state;
    const action = activeTool != null ? '正在调用 ' + activeTool : '思考中';
    return (
      <div className="work-indicator">
        <span className="wi-dot"></span>
        <span className="wi-text">{action}</span>
        <span className="wi-time">{elapsed >= 1 ? elapsed + 's' : '刚刚'}</span>
      </div>
    );
  }
}
