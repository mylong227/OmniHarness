// 过程折叠块：把相邻的 reasoning / tool_call / tool_result 合并成一个 <details>，
// summary 显示步数与工具分布。busy 时默认展开便于观察，空闲时默认收起聚焦结果。
//
// #OBS-13：用户手动开合后即「接管」，后续 busy 变化不再覆盖用户意图
// （用实例字段记录，避免 effect 依赖引发的死循环）。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import { processSummary, type ProcessBlock } from '../../textUtils.js';
import type { ThreadEvent } from '../../../types/models.js';

export interface ProcessClusterProps {
  block: ProcessBlock;
  onEventClick: (ev: ThreadEvent) => void;
  busy?: boolean;
  renderEvent: (ev: ThreadEvent) => ReactElement | null;
}

interface ProcessClusterState {
  /** 用户是否已手动开合过（接管后不再随 busy 自动变化）。 */
  userToggled: boolean;
}

/** 过程折叠块组件。 */
export class ProcessCluster extends React.Component<ProcessClusterProps, ProcessClusterState> {
  private detailsRef: HTMLDetailsElement | null = null;

  constructor(props: ProcessClusterProps) {
    super(props);
    this.state = { userToggled: false };
  }

  override componentDidMount(): void {
    this.syncOpen();
  }

  override componentDidUpdate(): void {
    this.syncOpen();
  }

  /** 把 DOM 的 open 同步到「忙碌则应展开」；用户接管后让位。 */
  private syncOpen(): void {
    const d = this.detailsRef;
    if (!d || this.state.userToggled) return;
    const shouldOpen = this.props.busy === true;
    if (d.open !== shouldOpen) d.open = shouldOpen;
  }

  /** 用户主动开合：置位接管标志。 */
  private readonly onToggle = (): void => {
    if (!this.state.userToggled) this.setState({ userToggled: true });
  };

  override render(): ReactElement {
    const { block, busy, renderEvent } = this.props;
    const isOpen = busy === true;
    const text = processSummary(block.events);
    return (
      <details
        className="ev process-cluster"
        ref={(el: HTMLDetailsElement | null) => {
          this.detailsRef = el;
        }}
        open={isOpen}
        onToggle={this.onToggle}
      >
        <summary
          className="tc-line dim"
          title={isOpen ? '过程进行中（自动展开）' : '点击查看执行过程'}
        >
          <span className="tc-chevron-cluster"></span>
          <span className="tc-icon">⏵</span>
          <span className="tc-summary">执行过程 — {esc(text)}</span>
          <span className="time">{block.events.length} 步</span>
        </summary>
        <div className="process-cluster-body">{block.events.map((ev) => renderEvent(ev))}</div>
      </details>
    );
  }
}
