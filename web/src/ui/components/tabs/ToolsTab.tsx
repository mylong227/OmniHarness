// 工具面板：展示本次会话触发的工具调用清单（名称 + 状态点），点击定位到事件流中的对应卡片。
// 纯展示组件（函数组件范式）：列表数据由 props 注入，无内部状态、无副作用。
// 「状态 → 中文」的纯映射下沉为模块级函数（零 React 依赖，可单测）。

import { React } from '../../deps.js';
import { emptyState } from '../../format.js';
import type { ToolItem } from '../../shared.js';

/** ToolsTab 组件的入参。 */
export interface ToolsTabProps {
  /** 本次会话已触发的工具调用清单。 */
  toolItems: ToolItem[];
  /** 点击某条工具调用时定位到事件流中对应卡片。 */
  onShowTool: (callId: string) => void;
}

/**
 * 工具状态中文映射：未知状态显示省略号（fail-closed 到中性展示）。
 * @param status 工具状态标识
 * @returns 中文状态文案
 */
function statusText(status: string): string {
  if (status === 'ok') return '完成';
  if (status === 'err') return '失败';
  return '…';
}

/**
 * 工具面板：渲染工具调用清单；列表为空时展示空状态指引。
 * @param props 组件入参
 * @returns 工具清单节点（空列表时为空状态节点）
 */
export function ToolsTab(props: ToolsTabProps): ReactElement {
  const { toolItems, onShowTool } = props;
  if (toolItems.length === 0) {
    return emptyState(
      '🛠️',
      '暂无工具调用',
      '模型执行读文件、运行命令、搜索等工具时，调用与结果会在此汇总。',
    );
  }
  return (
    <div id="toolList">
      {toolItems.map((t) => (
        <div
          key={t.callId}
          className={'tool-item ' + t.status}
          onClick={() => onShowTool(t.callId)}
        >
          <span className="dot"></span>
          <span>{t.name}</span>
          <span className="state">{statusText(t.status)}</span>
        </div>
      ))}
    </div>
  );
}
