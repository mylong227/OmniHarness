// 事件级渲染函数（2026-11-01 从 StreamView 下沉）：按事件类型产出对话流节点。
//
// 独立成文件的原因：StreamView.tsx 挂着文件行数基线（check.mjs 白名单，只减不增），
// 原地抽函数带 JSDoc 会让文件越线；且这些渲染函数本就自包含——只吃事件与只读上下文，
// 分派器（renderEventNode）留在 StreamView，这里只放「叶子渲染」。
// S2 长函数清偿批次：renderEventNode 体 135 → <80。

import * as React from 'react';
import { badge, jsonView, questionView, todoView } from '../../format.ts';
import { icon } from '../../models/Icon.ts';
import { CompactionNote } from '../../models/CompactionNote.ts';
import { NumberFormatter } from '../../models/NumberFormatter.ts';
import { t } from '../../i18n/i18n.ts';
import type { ThreadEvent } from '../../../types/models.ts';
import type { ToolResultView } from '../../shared.ts';

/** 事件渲染上下文（StreamView 组装，渲染函数只读）。 */
export interface EventCtx {
  toolResults: Record<string, ToolResultView>;
  onEventClick: (ev: ThreadEvent) => void;
  onOpenFile?: (path: string) => Promise<boolean> | boolean | void;
  /** 在右栏网页标签打开本地地址（缺省时不渲染该入口）。 */
  onOpenUrl?: (url: string) => void;
  busy?: boolean;
  /** 最后一条用户消息 id（仅它可编辑重发）。 */
  lastUserId: string;
  /** 最后一条助手消息 id（仅它可重新生成）。 */
  lastAssistantId: string;
  onEditUser?: () => void;
  onRegenerate?: () => void;
  /** 已被 assistant 事件收口的流式文本。 */
  finalizedStreamText: string;
  /** 本回合出现过的工具调用 id（只读：仅用于 `has` 判定）。 */
  toolCallIds: ReadonlySet<string>;
  /** 每段对话（user 事件 id）的独立用时。 */
  turnDurations: ReadonlyMap<string, number>;
  /** 是否正有提问等待作答（对话流里的提问卡据此给出「去下方提问卡作答」的指引）。 */
  questionPending: boolean;
  /** 回合刚收尾（1.5s 内）：思考轨迹挂载瞬间的「回闪」高亮。历史加载恒 false。 */
  clusterFresh: boolean;
}

/** 事件包装器形态（给 ev 套统一外壳并可点击钻取）。 */
export type EvWrapper = (inner: React.ReactElement) => React.ReactElement;

/**
 * 孤儿工具结果（调用被历史截断）折叠成一行可展开的独立事件。
 * @param ev 事件本体
 * @param p 事件负载
 * @returns 节点
 */
export function renderStandaloneToolResult(ev: ThreadEvent, p: Record<string, unknown>): React.ReactElement {
  return (
    <details className="ev tool_result standalone" key={ev.id}>
      <summary className="tc-line dim">
        <span className="tc-chevron">▸</span>
        <span className="tc-icon">{icon('undo', { size: 14 })}</span>
        <span className="tc-summary">{t('工具结果（独立事件）')}</span>
      </summary>
      <div className="tc-detail">
        <div className="tool-output">{JSON.stringify(p)}</div>
      </div>
    </details>
  );
}

/**
 * system 事件：压缩游标收成一行简报（点击展开摘要全文，阻断冒泡防误触钻取），
 * 其余 system 文本渲染为普通系统注记。
 * @param p 事件负载
 * @param node 事件包装器
 * @returns 节点
 */
export function renderSystemNode(
  p: Record<string, unknown>,
  node: EvWrapper,
): React.ReactElement {
  const sysContent = (p.content as string) || '';
  const compaction = CompactionNote.parse(sysContent);
  if (compaction !== null) {
    // 压缩游标事件（OMNI_COMPACTION_V1）：摘要动辄数千字，平铺会糊满一屏
    // （2026-10-13 用户反馈）。收纳成一行简报，点击展开摘要全文；
    // 点击阻断冒泡——details 的开合不应顺带触发外层的事件钻取。
    return node(
      <details
        className="sysnote-fold"
        spellCheck="false"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <summary className="sysnote-fold__summary">
          {t('— 上下文已压缩 · 游标 upTo={upTo} · 摘要约 {n} 字 · 点击查看 —', {
            upTo: String(compaction.upTo),
            n: NumberFormatter.abbrev(compaction.summary.length),
          })}
        </summary>
        <div className="sysnote-fold__body">{compaction.summary}</div>
      </details>,
    );
  }
  return node(
    <div className="sysnote" spellCheck="false">
      — {sysContent} —
    </div>,
  );
}

/**
 * 待办清单事件：badge 头 + 待办视图。
 * @param p 事件负载
 * @param node 事件包装器
 * @returns 节点
 */
export function renderTodoNode(p: Record<string, unknown>, node: EvWrapper): React.ReactElement {
  return node(
    <>
      <div className="head">{badge('todo')}</div>
      {todoView((p.todos as Parameters<typeof todoView>[0]) || [])}
    </>,
  );
}

/**
 * 计划事件：badge 头 + JSON 视图。
 * @param p 事件负载
 * @param node 事件包装器
 * @returns 节点
 */
export function renderPlanNode(p: Record<string, unknown>, node: EvWrapper): React.ReactElement {
  return node(
    <>
      <div className="head">{badge('plan')}</div>
      <div className="card">{jsonView(p)}</div>
    </>,
  );
}

/**
 * 提问事件：badge 头 + 提问卡（pending 态由 ctx 传入）。
 * @param p 事件负载
 * @param ctx 渲染上下文
 * @param node 事件包装器
 * @returns 节点
 */
export function renderQuestionNode(
  p: Record<string, unknown>,
  ctx: EventCtx,
  node: EvWrapper,
): React.ReactElement {
  return node(
    <>
      <div className="head">{badge('question')}</div>
      <div className="card">{questionView((p.questions as unknown) || p, { pending: ctx.questionPending })}</div>
    </>,
  );
}

/**
 * 未知事件类型兜底：badge 头 + JSON 全文（新事件先可见、后美化）。
 * @param ev 事件本体
 * @param p 事件负载
 * @param node 事件包装器
 * @returns 节点
 */
export function renderUnknownNode(
  ev: ThreadEvent,
  p: Record<string, unknown>,
  node: EvWrapper,
): React.ReactElement {
  return node(
    <>
      <div className="head">{badge(ev.type)}</div>
      <div className="card">
        <div className="content" spellCheck="false">
          {JSON.stringify(p)}
        </div>
      </div>
    </>,
  );
}
