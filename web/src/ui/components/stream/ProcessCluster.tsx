// 过程折叠块：把相邻的 reasoning / tool_call / tool_result 合并成一个 <details>，
// summary 显示步数与工具分布。busy 时默认展开便于观察，空闲时默认收起聚焦结果。
//
// #OBS-13：用户手动开合后即「接管」，后续 busy 变化不再覆盖用户意图
// （用 state 记录「已接管」，effect 依赖显式列出，不比对 prev、不死循环）。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import { processSummary, type ProcessBlock } from '../../textUtils.js';
import type { ThreadEvent } from '../../../types/models.js';

/** ProcessCluster 组件的入参。 */
export interface ProcessClusterProps {
  /** 合并后的过程块（相邻 reasoning / tool_call / tool_result）。 */
  block: ProcessBlock;
  /** 点击内部事件卡片时上抛（钻取）。 */
  onEventClick: (ev: ThreadEvent) => void;
  /** 回合是否进行中（进行中默认展开，便于观察）。 */
  busy?: boolean;
  /** 渲染单个子事件的回调（由 StreamView 注入，避免循环依赖）。 */
  renderEvent: (ev: ThreadEvent) => ReactElement | null;
}

/**
 * 过程折叠块：把相邻过程事件折叠进一个 details，busy 时自动展开、用户接管后让位。
 * @param props 组件入参
 * @returns 过程折叠块节点
 */
export function ProcessCluster(props: ProcessClusterProps): ReactElement {
  const { block, busy, renderEvent } = props;
  const [userToggled, setUserToggled] = React.useState<boolean>(false);
  const detailsRef = React.useRef<HTMLDetailsElement | null>(null);
  const isOpen = busy === true;

  // 把 DOM 的 open 同步到「忙碌则应展开」；用户接管后让位（清理对称：无定时器/订阅需释放）。
  React.useEffect(() => {
    const d = detailsRef.current;
    if (!d || userToggled) return;
    if (d.open !== isOpen) d.open = isOpen;
  }, [userToggled, isOpen]);

  /** 用户主动开合：置位接管标志，后续 busy 变化不再覆盖用户意图。 */
  const onToggle = (): void => {
    if (!userToggled) setUserToggled(true);
  };

  const text = processSummary(block.events);
  return (
    <details
      className="ev process-cluster"
      ref={(el: HTMLDetailsElement | null) => {
        detailsRef.current = el;
      }}
      open={isOpen}
      onToggle={onToggle}
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
