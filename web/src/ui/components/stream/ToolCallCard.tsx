// 工具调用行：默认只显示「调了什么 + 参数摘要 + 状态」，点击展开 args 与结果详情。
// 失败时把 error 摘要直接显示在行尾（不折叠）——沙箱拒绝 / 路径越界等根因不该被藏起来。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { jsonView, timeOf, esc } from '../../format.js';
import { truncate, describeToolCall } from '../../textUtils.js';
import { ArtifactResolver } from '../../models/ArtifactResolver.js';
import { ArtifactCard } from './ArtifactCard.js';
import type { ThreadEvent } from '../../../types/models.js';
import type { ToolResultView } from '../StreamView.js';

export interface ToolCallCardProps {
  ev: ThreadEvent;
  res?: ToolResultView;
  onEventClick: (ev: ThreadEvent) => void;
  onOpenFile?: (path: string) => void;
}

interface ToolCallCardState {
  open: boolean;
}

/** 工具调用卡片组件。 */
export class ToolCallCard extends AppComponent<ToolCallCardProps, ToolCallCardState> {
  constructor(props: ToolCallCardProps) {
    super(props);
    this.state = { open: false };
  }

  private readonly toggle = (): void => {
    this.setState((prev) => ({ open: !prev.open }));
  };

  /** 钻取：阻断冒泡，避免同时触发外层的事件点击。 */
  private readonly drill = (e: MouseEvent): void => {
    e.stopPropagation();
    this.props.onEventClick(this.props.ev);
  };

  override render(): ReactElement {
    const { ev, res, onOpenFile } = this.props;
    const { open } = this.state;
    const p = ev.payload || {};
    const status = res ? (res.ok ? 'ok' : 'err') : 'pending';
    const statusText = res ? (res.ok ? '成功' : '失败') : '运行中…';
    const toolName = (p.name as string) || 'tool';
    const description = describeToolCall(toolName, p.args);
    const errText = res && !res.ok && res.text ? res.text.replace(/^✗\s*/, '') : '';
    const artifact = res && res.ok ? ArtifactResolver.fromTool(toolName, p.args) : null;
    return (
      <div className="ev tool_call">
        <div
          className="tc-line"
          onClick={this.toggle}
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
            <button className="tc-drill" title="在右侧钻取面板查看原始事件" onClick={this.drill}>
              ⤢ 在钻取面板查看
            </button>
          </div>
        ) : null}
      </div>
    );
  }
}
