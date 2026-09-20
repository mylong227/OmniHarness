// 流式助手卡片：把 `thread.text_delta` 累积出的正文逐字渲染出来。
//
// 与 AssistantCard 的分工：本卡片只负责「正在生成的这一屏」——正文来自增量拼接（随时可能增长），
// 因此**不做**渐进揭示动画（文本本身就是一点点长出来的，再叠一层动画只会抽搐）；
// 回合内的 assistant 事实事件到来后本条由 StreamView 撤下，改由 AssistantCard 接管最终正文。
//
// a11y（D1/D2 + B4）：正文整块 aria-hidden。半句话对屏幕阅读器是噪声，且父级 role=log 的 polite 播报区
// 会随每个增量反复朗读——正确做法是等正文落成事实事件后，由最终卡片整段播报一次。
// 生成期间改由本卡片内**独立的** polite 状态区播报，且粒度刻意做粗：文案只在跨过百字档位时才变，
// 逐字变化不会触发重播（`aria-atomic=false` 也救不了每秒几十次的文本变更，只能靠「少变」）。
//
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { React } from '../../deps.js';
import { badge, renderMarkdown } from '../../format.js';

/** StreamingAssistantCard 组件的入参。 */
export interface StreamingAssistantCardProps {
  /** 已累积的流式正文。 */
  text: string;
}

/** 播报粒度：每满这么多字符才更新一次状态文案（其余时刻文本不变 ⇒ 不重播）。 */
const ANNOUNCE_STEP = 100;

/**
 * 生成中的播报文案（粗粒度，避免逐字轰炸屏幕阅读器）。
 * @param length 已生成字符数
 * @returns 状态文案
 */
function announceText(length: number): string {
  if (length < ANNOUNCE_STEP) return '助手正在生成回复';
  return (
    '助手正在生成回复（已约 ' + String(Math.floor(length / ANNOUNCE_STEP) * ANNOUNCE_STEP) + ' 字）'
  );
}

/**
 * 流式助手卡片：渲染正在生成中的正文（带光标）与粗粒度播报状态。
 * @param props 组件入参
 * @returns 生成中的助手卡片节点
 */
export function StreamingAssistantCard(props: StreamingAssistantCardProps): ReactElement {
  const { text } = props;
  return (
    <div className="ev assistant streaming-assistant">
      <div className="head">
        {badge('assistant')}
        <span className="time">生成中…</span>
      </div>
      <div className="card assistant streaming">
        <div className="content" spellCheck="false" aria-hidden="true">
          {renderMarkdown(text)}
          <span className="stream-caret"></span>
        </div>
      </div>
      <div className="stream-status" role="status" aria-live="polite" aria-atomic="true">
        {announceText(text.length)}
      </div>
    </div>
  );
}
