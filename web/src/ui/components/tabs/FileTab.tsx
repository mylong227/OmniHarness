// 文件面板：点击文件树节点 / 产物卡片 / markdown 文件链接后，在右侧显示文件内容。
// #OBS-14：代码类文件用内置 tokenizer 做语法高亮（分颜色，参考 WorkBuddy 点文件在
// 编辑器里查看）。
// #OBS-15：markdown 文件用 renderMarkdown 渲染成真 Markdown（标题/列表/代码块/链接/表格），
// 不再退化成纯文本；json 也进高亮。其余（txt/未知）纯文本展示。
//
// 面向对象改造：折叠态由组件自身 state 管理（原 useState），
// 「语言分类」判据抽为 FileKindClassifier（零 React，可单测）。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
import { highlightCode, langOf } from '../../highlight.js';
import { renderMarkdown } from '../../format.js';
import type { FileView } from '../../shared.js';
import { FileKindClassifier } from '../../models/FileKindClassifier.js';

export interface FileTabProps {
  fileView: FileView | null;
}

interface FileTabState {
  /** 内容区是否展开（标题行点击切换）。 */
  open: boolean;
}

/** 右侧面板打开的非代码内容也按此限制展示文本（防止超长文件卡死渲染）。 */
const MAX_PREVIEW = 40000;

/** 文件面板组件：可折叠的文件内容预览。 */
export class FileTab extends AppComponent<FileTabProps, FileTabState> {
  constructor(props: FileTabProps) {
    super(props);
    this.state = { open: true };
  }

  /** 切换展开 / 收起。 */
  private readonly toggle = (): void => {
    this.setState((prev) => ({ open: !prev.open }));
  };

  /** 按语言渲染正文：代码走高亮，markdown 走渲染器，其余纯文本。 */
  private renderBody(fileView: FileView): ReactElement | null {
    if (fileView.content === '') return null;
    const lang = fileView.lang || langOf(fileView.title);
    const clipped = fileView.content.slice(0, MAX_PREVIEW);
    if (FileKindClassifier.isCode(lang)) {
      return highlightCode(clipped, lang);
    }
    if (FileKindClassifier.isMarkdown(lang)) {
      return (
        <div className="file-md-scroll" spellCheck="false">
          {renderMarkdown(clipped)}
        </div>
      );
    }
    return (
      <pre className="file-content" spellCheck="false">
        {fileView.content}
      </pre>
    );
  }

  override render(): ReactElement {
    const { fileView } = this.props;
    if (!fileView) {
      return (
        <div className="empty">
          在左侧文件树点击文件、或点击产物卡片的「打开」即可在此查看内容。
        </div>
      );
    }
    const { open } = this.state;
    return (
      <div className="file-pane">
        <div
          className="file-row"
          onClick={this.toggle}
          title={open ? '收起' : '展开查看内容'}
        >
          <span className="file-caret">{open ? '▾' : '▸'}</span>
          <span className="file-name">{fileView.title}</span>
          <span className="file-meta">{fileView.meta}</span>
        </div>
        {open ? this.renderBody(fileView) : null}
      </div>
    );
  }
}
