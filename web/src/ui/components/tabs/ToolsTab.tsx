// 工具面板：展示本次会话触发的工具调用清单（名称 + 状态点），点击定位到事件流中的对应卡片。
// 纯展示组件：列表数据由 props 注入，无内部状态。

import { React } from '../../deps.js';
import { emptyState } from '../../format.js';
import type { ToolItem } from '../../shared.js';

export interface ToolsTabProps {
  toolItems: ToolItem[];
  onShowTool: (callId: string) => void;
}

/** 工具面板组件。 */
export class ToolsTab extends React.Component<ToolsTabProps> {
  /** 工具状态中文映射：未知状态显示省略号（fail-closed 到中性展示）。 */
  private statusText(status: string): string {
    if (status === 'ok') return '完成';
    if (status === 'err') return '失败';
    return '…';
  }

  private renderItem(t: ToolItem): ReactElement {
    const { onShowTool } = this.props;
    return (
      <div
        key={t.callId}
        className={'tool-item ' + t.status}
        onClick={() => onShowTool(t.callId)}
      >
        <span className="dot"></span>
        <span>{t.name}</span>
        <span className="state">{this.statusText(t.status)}</span>
      </div>
    );
  }

  override render(): ReactElement {
    const { toolItems } = this.props;
    if (toolItems.length === 0) {
      return emptyState(
        '🛠️',
        '暂无工具调用',
        '模型执行读文件、运行命令、搜索等工具时，调用与结果会在此汇总。',
      );
    }
    return <div id="toolList">{toolItems.map((t) => this.renderItem(t))}</div>;
  }
}
