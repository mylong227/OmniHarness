// 排队消息坞（2026-10-31「队列模式」的输入区上方浮层）。
//
// ## 交互口径（用户需求原文）
//
// 「聊天框实现 UI 队列排队信息，多条只展示马上轮到的第一条，点击上推出一个队列列表
//   滚动可以浏览队列发出的全部信息」——
//   · 收起态：**只**显示下一条（序号 1）、模式、剩余条数；
//   · 点击抬头：向上展开全部排队项（可滚动），逐条可浏览 / 置顶 / 删除；
//   · 内容形态与输入区一致：文字、图片、视频、GIF、文件、链接。
//
// ## 为什么是"向上展开"
//
// 坞挂在输入框**正上方**，展开内容自然向上生长；用户视线与操作都停留在输入区附近，
// 不会把正在读的对话流顶走（若向下展开会盖住输入框，等于挡住"继续打字"这条主动作）。
//
// 纯展示组件：队列真相在 ComposerController，操作经 ChatQueueView 回调上抛。

import * as React from 'react';
import { icon } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';
import { ChatModePreference } from '../models/ChatModePreference.ts';
import {
  ChatQueuePreview,
  type ChatQueueView,
  type QueuedMessage,
  type QueueAttachmentView,
} from '../models/ChatMessageQueue.ts';
import { AttachmentIcon } from '../models/AttachmentIcon.ts';

/** 队列坞入参。 */
export interface ChatQueueDockProps {
  /** 队列视图契约（items 已按当前会话过滤；空队列时组件返回 null）。 */
  readonly queue: ChatQueueView;
}

/**
 * 附件缩略条（图片 / 视频 / GIF 走缩略图，其余走文件图标）。
 * @param props 附件视图数组
 * @returns 附件条节点；无附件时为 null
 */
function QueueAttachments(props: { items: readonly QueueAttachmentView[] }): ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <div className="cq-atts">
      {props.items.map((item) => {
        if ((item.kind === 'image' || item.kind === 'video') && item.previewUrl !== undefined) {
          return item.kind === 'video' ? (
            <video
              key={item.key}
              className="cq-thumb"
              src={item.previewUrl}
              muted
              playsInline
              preload="metadata"
              title={item.name}
            />
          ) : (
            <img key={item.key} className="cq-thumb" src={item.previewUrl} alt={item.name} title={item.name} />
          );
        }
        return (
          <span className="cq-file" key={item.key} title={item.name}>
            <span className="cq-file-ico" aria-hidden="true">
              {icon(AttachmentIcon.iconName(item.mediaType), { size: 13 })}
            </span>
            <span className="cq-file-name">{item.name}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * 一条排队项的完整预览（文字 + 附件 + 外链）。
 * @param props 队列项
 * @returns 内容节点
 */
function QueueItemContent(props: { item: QueuedMessage }): ReactElement {
  const { item } = props;
  const links = ChatQueuePreview.linksOf(item);
  return (
    <div className="cq-item-main">
      {item.prompt.trim() === '' ? null : <div className="cq-text">{item.prompt}</div>}
      <QueueAttachments items={ChatQueuePreview.attachmentsOf(item)} />
      {links.length === 0 ? null : (
        <div className="cq-links">
          {links.map((url) => (
            <a
              key={url}
              className="cq-link"
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              title={url}
            >
              {icon('link', { size: 12 })}
              {url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 展开态队列体：全部排队消息（置顶 / 删除）+ 清空 / 收起工具条。
 * @param props 队列项与各操作回调（onCollapse 收起展开态）。
 * @returns 展开体节点；队列空时不渲染。
 */
function QueueBody(props: {
  readonly items: ChatQueueView['items'];
  readonly onPromote: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
  readonly onCollapse: () => void;
}): ReactElement | null {
  if (props.items.length === 0) return null;
  return (
      <div className="cq-body">
        <ol className="cq-list" aria-label={t('排队中的全部消息')}>
          {props.items.map((item, index) => (
            <li className="cq-item" key={item.id} data-queue-id={item.id}>
              <span className="cq-index" aria-hidden="true">
                {index + 1}
              </span>
              <QueueItemContent item={item} />
              <div className="cq-actions">
                <button
                  type="button"
                  className="cq-pin"
                  disabled={index === 0}
                  title={t('置顶（下一条就发它）')}
                  aria-label={t('置顶第 {n} 条', { n: index + 1 })}
                  onClick={() => props.onPromote(item.id)}
                >
                  {icon('arrow-left', { size: 13 })}
                </button>
                <button
                  type="button"
                  className="cq-del"
                  title={t('从队列删除')}
                  aria-label={t('删除第 {n} 条', { n: index + 1 })}
                  onClick={() => props.onRemove(item.id)}
                >
                  {icon('x', { size: 13 })}
                </button>
              </div>
            </li>
          ))}
        </ol>
        <div className="cq-foot">
          <span className="cq-hint">{t('按顺序逐条发送；点「停止」会暂停队列。')}</span>
          <span className="flex-spacer" aria-hidden="true" />
          <button type="button" className="cq-clear" onClick={() => props.onClear()}>
            {t('清空队列')}
          </button>
          <button type="button" className="cq-collapse" onClick={props.onCollapse}>
            {t('收起')}
          </button>
        </div>
      </div>

  );
}
/**
 * 排队消息坞：收起态只显示下一条，点击抬头向上展开全部。
 * @param props 队列视图契约
 * @returns 坞节点；无排队项时为 null
 */
export function ChatQueueDock(props: ChatQueueDockProps): ReactElement | null {
  const { queue } = props;
  const [expanded, setExpanded] = React.useState(false);
  if (props.queue.items.length === 0) return null;
  const first = props.queue.items[0];
  if (first === undefined) return null;
  const attachments = ChatQueuePreview.countOf(first);
  const rest = props.queue.items.length - 1;
  return (
    <section className="chat-queue" aria-label={t('排队消息')} data-queue-count={props.queue.items.length}>
      <div className="cq-head-row">
        <button
          type="button"
          className="cq-head"
          aria-expanded={expanded ? 'true' : 'false'}
          title={expanded ? t('收起队列') : t('展开队列，查看全部 {n} 条', { n: props.queue.items.length })}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className="cq-badge" aria-hidden="true">
            {icon('inbox', { size: 14 })}
          </span>
          <span className="cq-mode">{t(ChatModePreference.labelOf(queue.mode))}</span>
          <span className="cq-count">{t('{n} 条排队', { n: props.queue.items.length })}</span>
          <span className="cq-state">
            {queue.paused ? t('已暂停') : queue.busy ? t('当前任务结束后发送') : t('即将发送')}
          </span>
          <span className="cq-preview" title={ChatQueuePreview.summaryOf(first)}>
            {ChatQueuePreview.summaryOf(first)}
          </span>
          {attachments === 0 ? null : (
            <span className="cq-atts-count" title={t('附件 {n} 个', { n: attachments })}>
              {icon('paperclip', { size: 12 })}
              {attachments}
            </span>
          )}
          <span className={'cq-caret' + (expanded ? ' on' : '')} aria-hidden="true">
            {icon('chevron-down', { size: 13 })}
          </span>
        </button>
        {rest === 0 ? null : <span className="cq-more">{t('还有 {n} 条', { n: rest })}</span>}
      </div>

      {queue.paused ? (
        <div className="cq-paused" role="status">
          <span>{t('队列已暂停（你点了停止）。继续后会接着发送。')}</span>
          <button type="button" className="cq-resume" onClick={() => queue.onResume()}>
            {t('继续发送')}
          </button>
        </div>
      ) : null}

      {expanded ? (
        <QueueBody
          items={props.queue.items}
          onPromote={queue.onPromote}
          onRemove={queue.onRemove}
          onClear={queue.onClear}
          onCollapse={() => setExpanded(false)}
        />
      ) : null}
    </section>
  );
}
