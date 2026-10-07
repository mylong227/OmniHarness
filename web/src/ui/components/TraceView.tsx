// 「轨迹」视图：把当前会话的工具调用压成一张紧凑时间线（截图式三栏壳的中栏第二视图）。
// 与「对话」的区别：不渲染任何正文 / 推理，只留「图标 + 动作 + 状态 + 时间」一行一条，
// 用来回答「这一轮到底动了哪些文件、跑了哪些命令」。数据完全来自既有事件流，不新增请求。
//
// 函数组件范式：无内部状态；行渲染下沉为模块级纯函数（与 StreamView 同款写法）。

import { React } from '../deps.js';
import { icon } from '../models/Icon.js';
import type { IconName } from '../models/Icon.js';
import { describeToolCall } from '../textUtils.js';
import { timeOf } from '../format.js';
import type { ThreadEvent } from '../../types/models.js';
import type { LiveInput, ToolResultView } from '../shared.js';

/** TraceView 组件的入参。 */
export interface TraceViewProps {
  /** 会话事件（从中筛 tool_call）。 */
  events: ThreadEvent[];
  /** 流式中的工具输入（尚无事件落盘，作为"进行中"行追加在末尾）。 */
  liveInputs: LiveInput[];
  /** 工具结果视图（有结果的调用显示「完成」）。 */
  toolResults: Record<string, ToolResultView>;
}

/** 单行轨迹（模块级中间形态，渲染前组装）。 */
interface TraceRow {
  /** 稳定 key（事件 id 或流式输入 id）。 */
  key: string;
  /** 工具名（图标映射用）。 */
  name: string;
  /** 人话动作描述。 */
  action: string;
  /** 是否已完成（有结果回包）。 */
  done: boolean;
  /** 展示时间（事件时间戳；流式行无）。 */
  time: string;
}

/**
 * 工具名 → 线性图标。判据是工具名的关键词（read/edit/glob…），未识别回退扳手。
 * @param name 工具名
 * @returns 图标名
 */
function iconOfTool(name: string): IconName {
  const n = name.toLowerCase();
  if (n.includes('edit') || n.includes('write') || n.includes('patch')) return 'pencil';
  if (n.includes('read') || n.includes('cat')) return 'file';
  if (n.includes('search') || n.includes('grep') || n.includes('glob') || n.includes('find'))
    return 'search';
  if (n.includes('command') || n.includes('bash') || n.includes('shell') || n.includes('run'))
    return 'wrench';
  if (n.includes('file') || n.includes('fs') || n.includes('ls')) return 'folder';
  return 'wrench';
}

/**
 * 从事件流组装轨迹行（保持时间顺序；孤儿结果不显示——它没有对应的"动作"可讲）。
 *
 * 完成判据有两条来源：`toolResults`（本回合实时合并的结果视图）**与**事件流里的
 * `tool_result` 事件（加载历史会话时结果以独立事件回放，`toolResults` 未必填充——
 * 真机实测：历史会话的已完成调用被误标「进行中」）。两边任一命中即「完成」。
 * @param events 会话事件
 * @param toolResults 工具结果
 * @returns 轨迹行列表
 */
function collectRows(events: readonly ThreadEvent[], toolResults: Record<string, ToolResultView>): TraceRow[] {
  const doneCallIds = new Set<string>(Object.keys(toolResults));
  for (const ev of events) {
    if (ev.type !== 'tool_result') continue;
    const p = (ev.payload || {}) as Record<string, unknown>;
    const callId = p.callId as string | undefined;
    if (callId !== undefined && callId !== '') doneCallIds.add(callId);
  }
  const rows: TraceRow[] = [];
  for (const ev of events) {
    if (ev.type !== 'tool_call') continue;
    const p = (ev.payload || {}) as Record<string, unknown>;
    const name = (p.name as string) || '';
    if (name === '') continue;
    const callId = (p.callId as string) || ev.id;
    rows.push({
      key: ev.id,
      name,
      action: describeToolCall(name, (p.args as Record<string, unknown>) || p),
      done: doneCallIds.has(callId),
      time: timeOf(ev.timestamp),
    });
  }
  return rows;
}

/**
 * 轨迹视图：紧凑工具时间线；空态给一句说明（不是空白）。
 * @param props 组件入参
 * @returns 轨迹节点
 */
export function TraceView(props: TraceViewProps): ReactElement {
  const { events, liveInputs, toolResults } = props;
  const rows = collectRows(events, toolResults);
  const running = rows.filter((r) => !r.done).length;
  return (
    <div className="trace" role="log" aria-label="工具调用轨迹">
      <div className="trace-head" aria-hidden="true">
        共 {String(rows.length)} 次工具调用{running > 0 ? ' · ' + String(running) + ' 次进行中' : ''}
      </div>
      {rows.length === 0 && liveInputs.length === 0 ? (
        <div className="trace-empty">本轮还没有工具调用。发起任务后，读取 / 编辑 / 命令会按顺序出现在这里。</div>
      ) : (
        <div className="trace-list">
          {rows.map((r) => (
            <div className="tr-row" key={r.key}>
              <span className="tr-ico" aria-hidden="true">
                {icon(iconOfTool(r.name), { size: 14 })}
              </span>
              <span className="tr-act" title={r.action}>
                {r.action}
              </span>
              <span className={r.done ? 'tr-st ok' : 'tr-st run'}>{r.done ? '完成' : '进行中'}</span>
              <span className="tr-time" aria-hidden="true">
                {r.time}
              </span>
            </div>
          ))}
          {liveInputs.map((li) => (
            <div className="tr-row" key={li.id}>
              <span className="tr-ico" aria-hidden="true">
                {icon('wrench', { size: 14 })}
              </span>
              <span className="tr-act">
                {(() => {
                  let args: unknown = {};
                  try {
                    args = JSON.parse(li.partial);
                  } catch {
                    args = {};
                  }
                  return describeToolCall(li.name, args);
                })()}
              </span>
              <span className="tr-st run">进行中</span>
              <span className="tr-time" aria-hidden="true"></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
