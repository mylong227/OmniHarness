// 长内容简报卡：默认收起为「文档附件」式简报（标题 + 字数 + 前几行预览），点击展开全文。
//
// 背景（2026-10-13 用户反馈）：目录分析报告、压缩摘要这类数千字回复在对话流里整段平铺，
// 一屏全被占满。本卡把长正文收纳成一张简报卡——「简明扼要」靠**取舍原文**实现（截前几行），
// 不靠再生成；展开/收起由用户点击驱动。
//
// 纯展示组件（函数组件范式）：唯一内部状态是展开态；判定逻辑在 LongContentCollapser（可单测）。

import { React } from '../../deps.js';
import { renderMarkdown } from '../../format.js';
import { icon } from '../../models/Icon.js';
import { LongContentCollapser } from '../../models/LongContentCollapser.js';
import { NumberFormatter } from '../../models/NumberFormatter.js';

/** CollapsibleDoc 组件的入参。 */
export interface CollapsibleDocProps {
  /** 完整正文（已判定为长内容）。 */
  content: string;
}

/**
 * 长内容简报卡：收起态 = 标题行 + 预览（带底部渐隐掩码）；展开态 = 全文渲染。
 * @param props 组件入参
 * @returns 简报卡节点
 */
export function CollapsibleDoc(props: CollapsibleDocProps): ReactElement {
  const { content } = props;
  const [open, setOpen] = React.useState(false);
  const d = LongContentCollapser.digest(content);

  /**
   * 切换展开态：阻断冒泡——外层 .ev.clickable 会把点击上抛为事件钻取，
   * 「展开全文」不应顺带打开右侧详情面板。
   * @param e 点击事件
   */
  const onToggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setOpen((v) => !v);
  };

  return (
    <div className={'doc-fold' + (open ? ' doc-fold--open' : '')}>
      <div className="doc-fold__head">
        <span className="doc-fold__ico" aria-hidden="true">
          {icon('file', { size: 14 })}
        </span>
        <span className="doc-fold__title" title={d.title}>
          {d.title}
        </span>
        <span className="doc-fold__meta">约 {NumberFormatter.abbrev(d.chars)} 字</span>
        <button
          type="button"
          className="doc-fold__toggle"
          aria-expanded={open ? 'true' : 'false'}
          onClick={onToggle}
        >
          {open ? '收起 ▴' : '展开全文 ▾'}
        </button>
      </div>
      {open ? (
        <div className="doc-fold__full">{renderMarkdown(content)}</div>
      ) : (
        <div className="doc-fold__preview">{renderMarkdown(d.preview)}</div>
      )}
    </div>
  );
}
