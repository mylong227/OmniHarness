// 工具面板：展示本次会话触发的工具调用清单（名称 + 状态点），点击定位到事件流中的对应卡片。

import { html } from '../../deps.js';
import { emptyState } from '../../format.js';
import type { ToolItem } from '../../shared.js';

export interface ToolsTabProps {
  toolItems: ToolItem[];
  onShowTool: (callId: string) => void;
}

export function ToolsTab(props: ToolsTabProps): ReactElement {
  const { toolItems, onShowTool } = props;
  if (toolItems.length === 0) {
    return emptyState('🛠️', '暂无工具调用', '模型执行读文件、运行命令、搜索等工具时，调用与结果会在此汇总。');
  }
  return html`<div id="toolList">
    ${toolItems.map(
      (t) =>
        html`<div key=${t.callId} className=${'tool-item ' + t.status} onClick=${() => onShowTool(t.callId)}>
          <span className="dot"></span><span>${t.name}</span
          ><span className="state">${t.status === 'ok' ? '完成' : t.status === 'err' ? '失败' : '…'}</span>
        </div>`,
    )}
  </div>`;
}
