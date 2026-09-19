// 思考过程行：默认折叠为一行「💭 思考过程」，点开看全文——thinking 有提示但不刷屏。
// 函数组件范式：仅一个展开态，用 useState 承接。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

/** ReasoningBlock 组件的入参。 */
export interface ReasoningBlockProps {
  /** 思考事件（payload.content 为思考全文）。 */
  ev: ThreadEvent;
}

/**
 * 思考过程组件：默认折叠为摘要行，点击展开全文。
 * @param props 组件入参
 * @returns 思考过程节点
 */
export function ReasoningBlock(props: ReasoningBlockProps): ReactElement {
  const { ev } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const p = ev.payload || {};
  const content = (p.content as string) || '';
  // 函数式 updater：不依赖上一次渲染捕获的 open（H5 防陈旧闭包）。
  const toggle = (): void => setOpen((prev) => !prev);
  return (
    <div className="ev reasoning">
      <div
        className="tc-line dim"
        onClick={toggle}
        title={open ? '收起' : '点击查看思考内容'}
      >
        <span className="tc-chevron">{open ? '▾' : '▸'}</span>
        <span className="tc-icon">💭</span>
        <span className="tc-summary">思考过程 · {content.length} 字</span>
      </div>
      {open ? (
        <div className="tc-detail">
          <div className="reason-body" spellCheck="false">
            {esc(content)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
