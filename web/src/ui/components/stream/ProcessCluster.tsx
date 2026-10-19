// 过程折叠块：把相邻的 reasoning / tool_call / tool_result 合并成一个 <details>。
//
// 2026-10-19 重做（用户：「运行中的步骤要更简洁，现在看起来杂乱」）：
//   · **默认收起**——运行中也只占一行，不再把每一步铺开成一屏；
//   · 运行中那行只讲「此刻在做什么」+ 步数（`describeToolCall` 的人话动作），
//     完成后那行讲「这轮做了什么」的叙述式汇总（`processSummary`）；
//   · 步骤数按「动作」计（思考 + 工具调用），不把 tool_result 也算成一步（旧口径会虚高）；
//   · 失败次数在行尾如实标出；展开后才看得到每一条调用详情。
//
// 开合是**非受控**的：用户点开后就保持，busy 变化不再覆盖用户意图（#OBS-13 的同一诉求，
// 只是不再需要 state + effect 去驱动 open）。

import type { ReactElement } from 'react';
import { describeToolCall, processSummary, type ProcessBlock } from '../../textUtils.ts';
import { icon } from '../../models/Icon.ts';
import type { ThreadEvent } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

/** ProcessCluster 组件的入参。 */
export interface ProcessClusterProps {
  /** 合并后的过程块（相邻 reasoning / tool_call / tool_result）。 */
  block: ProcessBlock;
  /** 点击内部事件卡片时上抛（钻取）。 */
  onEventClick: (ev: ThreadEvent) => void;
  /** 回合是否进行中（决定摘要文案：正在做什么 / 做完了什么）。 */
  busy?: boolean;
  /** 回合刚收尾（busy true→false 的 1.5s 内）：挂载瞬间播一次「回闪」高亮（2026-10-14）。 */
  fresh?: boolean;
  /** 渲染单个子事件的回调（由 StreamView 注入，避免循环依赖）。 */
  renderEvent: (ev: ThreadEvent) => ReactElement | null;
}

/**
 * 取**最近一条**工具调用的人话动作；没有工具调用时回落到「思考中」。
 * @param events 过程事件
 * @returns 一行动作描述
 */
function latestAction(events: readonly ThreadEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.type !== 'tool_call') continue;
    const p = ev.payload || {};
    const name = typeof p.name === 'string' ? p.name : 'tool';
    return describeToolCall(name, p.args);
  }
  return t('思考中');
}

/**
 * 过程块的「动作数」：思考与工具调用各算一步，tool_result 不重复计数。
 * @param events 过程事件
 * @returns 动作数
 */
function stepCount(events: readonly ThreadEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type === 'tool_call' || ev.type === 'reasoning') n += 1;
  }
  return n;
}

/**
 * 失败结果数：`ok !== true` 的 tool_result 都算失败（缺字段按失败处理，fail-closed）。
 * @param events 过程事件
 * @returns 失败次数
 */
function failureCount(events: readonly ThreadEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type === 'tool_result' && ev.payload?.ok !== true) n += 1;
  }
  return n;
}

/**
 * 过程折叠块：一行摘要 + 可展开的完整步骤。
 * @param props 组件入参
 * @returns 过程折叠块节点
 */
export function ProcessCluster(props: ProcessClusterProps): ReactElement {
  const { block, busy, fresh, renderEvent } = props;
  const running = busy === true;
  const steps = stepCount(block.events);
  const failures = failureCount(block.events);
  const text = running
    ? t('执行中 — {action}', { action: latestAction(block.events) })
    : t('执行过程 — {text}', { text: processSummary(block.events) });

  return (
    <details
      className={'ev process-cluster' + (fresh ? ' cluster-fresh' : '')}
      data-running={running ? '1' : undefined}
    >
      <summary
        className="tc-line dim"
        title={running ? t('运行中 — 点击查看步骤') : t('点击查看执行过程')}
      >
        <span className="tc-chevron-cluster"></span>
        <span className={'tc-icon' + (running ? ' tc-running' : '')}>
          {icon('workflow', { size: 14 })}
        </span>
        <span className="tc-summary">{text}</span>
        <span className="process-meta">
          {failures > 0 ? (
            <span className="process-fail">{t('{n} 个失败', { n: failures })}</span>
          ) : null}
          <span className="time">{t('{n} 步', { n: steps })}</span>
        </span>
      </summary>
      <div className="process-cluster-body">{block.events.map((ev) => renderEvent(ev))}</div>
    </details>
  );
}
