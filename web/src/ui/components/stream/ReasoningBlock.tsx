// 思考过程行：默认折叠为一行「💭 思考过程」，点开看全文——thinking 有提示但不刷屏。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import type { ThreadEvent } from '../../../types/models.js';

export interface ReasoningBlockProps {
  ev: ThreadEvent;
}

interface ReasoningBlockState {
  open: boolean;
}

/** 思考过程组件。 */
export class ReasoningBlock extends React.Component<ReasoningBlockProps, ReasoningBlockState> {
  constructor(props: ReasoningBlockProps) {
    super(props);
    this.state = { open: false };
  }

  private readonly toggle = (): void => {
    this.setState((prev) => ({ open: !prev.open }));
  };

  override render(): ReactElement {
    const { open } = this.state;
    const p = this.props.ev.payload || {};
    const content = (p.content as string) || '';
    return (
      <div className="ev reasoning">
        <div
          className="tc-line dim"
          onClick={this.toggle}
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
}
