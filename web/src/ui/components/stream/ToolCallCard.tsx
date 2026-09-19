// 工具调用行：默认只显示「调了什么 + 参数摘要 + 状态」，点击展开 args 与结果详情。
// 失败时把 error 摘要直接显示在行尾（不折叠）——沙箱拒绝 / 路径越界等根因不该被藏起来。
// 函数组件范式：仅一个展开态。

import { React } from '../../deps.js';
import { jsonView, timeOf, esc } from '../../format.js';
import { truncate, describeToolCall } from '../../textUtils.js';
import { ArtifactResolver } from '../../models/ArtifactResolver.js';
import { ArtifactCard } from './ArtifactCard.js';
import type { ThreadEvent } from '../../../types/models.js';
import type { ToolResultView } from '../StreamView.js';

/** ToolCallCard 组件的入参。 */
export interface ToolCallCardProps {
  /** 工具调用事件（payload.name / payload.args）。 */
  ev: ThreadEvent;
  /** 该调用的结果视图（未返回时为 undefined）。 */
  res?: ToolResultView;
  /** 点击「在钻取面板查看」时上抛事件。 */
  onEventClick: (ev: ThreadEvent) => void;
  /** 打开产物文件（在右侧面板预览）。 */
  onOpenFile?: (path: string) => void;
}

/**
 * 工具调用卡片：摘要行 + 可展开的 args / 结果详情，失败时行尾直显错误。
 * @param props 组件入参
 * @returns 工具调用节点
 */
export function ToolCallCard(props: ToolCallCardProps): ReactElement {
  const { ev, res, onEventClick, onOpenFile } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const p = ev.payload || {};
  const status = res ? (res.ok ? 'ok' : 'err') : 'pending';
  const statusText = res ? (res.ok ? '成功' : '失败') : '运行中…';
  const toolName = (p.name as string) || 'tool';
  const description = describeToolCall(toolName, p.args);
  const errText = res && !res.ok && res.text ? res.text.replace(/^✗\s*/, '') : '';
  // 产物卡片：工具成功时解析出目标文件；草图类工具的路径由结果回执给出（故透传 res.text）。
  const artifact = res && res.ok ? ArtifactResolver.fromTool(toolName, p.args, res.text) : null;

  /** 展开 / 收起详情。 */
  const toggle = (): void => setOpen((prev) => !prev);

  /**
   * 钻取：阻断冒泡，避免同时触发外层的事件点击。
   * @param e 点击事件
   */
  const drill = (e: MouseEvent): void => {
    e.stopPropagation();
    onEventClick(ev);
  };

  return (
    <div className="ev tool_call">
      <div
        className="tc-line"
        onClick={toggle}
        title={open ? '收起详情' : '点击查看调用详情'}
      >
        <span className="tc-chevron">{open ? '▾' : '▸'}</span>
        <span className="tc-icon">🔧</span>
        <span className="tc-summary tc-action" title={esc(toolName)}>
          {esc(description)}
        </span>
        <span className={'tool-status ' + status}>{statusText}</span>
        <span className="time">{timeOf(ev.timestamp)}</span>
      </div>
      {errText ? (
        <div className="tc-error" title={esc(errText)}>
          ⚠ {esc(truncate(errText, 160))}
        </div>
      ) : null}
      {artifact ? <ArtifactCard info={artifact} onOpen={onOpenFile} /> : null}
      {open ? (
        <div className="tc-detail">
          {p.args ? jsonView(p.args) : null}
          <div className="tool-result">
            {res ? (
              <div className="tool-output">{esc(res.text)}</div>
            ) : (
              <div className="tool-output tc-waiting">等待结果…</div>
            )}
          </div>
          <button className="tc-drill" title="在右侧钻取面板查看原始事件" onClick={drill}>
            ⤢ 在钻取面板查看
          </button>
        </div>
      ) : null}
    </div>
  );
}
