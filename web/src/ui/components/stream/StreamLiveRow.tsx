// 流式参数占位行（2026-11-02 从 StreamView 下沉）。
//
// 尽力解析 partial JSON 提取人话动作，失败则用缺参兜底描述。
// 运行中的当前动作只占一行：工具行会在 `tool_call` 事件到达后由过程簇接管。
//
// 单独成文件的理由：这是一段自足的纯展示（事件还没落盘，只有流式入参），
// 和 StreamView 的滚动 / 虚拟化逻辑毫无耦合，抽出去后两边都更好读。

import * as React from 'react';
import { icon } from '../../models/Icon.ts';
import { toolSubject, toolVerb } from '../../textUtils.ts';
import { t } from '../../i18n/i18n.ts';
import type { LiveInput } from '../../shared.ts';

/** 流式占位行入参。 */
export interface StreamLiveRowProps {
  /** 流式输入（尚无落盘事件）。 */
  readonly li: LiveInput;
}

/**
 * 单条流式输入占位行：图标 + 动词 + 主语（解析不出参数时显示「准备中…」）。
 * @param props 组件入参
 * @returns 占位行节点
 */
export function StreamLiveRow(props: StreamLiveRowProps): React.ReactElement {
  const li = props.li;
  let partialArgs: unknown = {};
  try {
    partialArgs = JSON.parse(li.partial);
  } catch {
    partialArgs = {};
  }
  // 运行中的当前动作：只占一行（工具行会在 tool_call 事件到达后由过程簇接管）。
  const subject = toolSubject(li.name, partialArgs);
  return (
    <div className="ev live-input">
      <div className="tc-line dim">
        <span className="tc-icon tc-running" aria-hidden="true">
          {icon('thinking', { size: 14 })}
        </span>
        <span className="tc-verb">{t(toolVerb(li.name))}</span>
        <span className="tc-dot" aria-hidden="true">
          ·
        </span>
        <span className="tc-subject">{subject === '' ? t('准备中…') : subject}</span>
      </div>
    </div>
  );
}
