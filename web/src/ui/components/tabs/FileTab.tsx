// 文件面板：点击文件树节点 / 产物卡片 / markdown 文件链接后，在右侧显示文件内容。
// #OBS-14：代码类文件用内置 tokenizer 做语法高亮（分颜色，参考 WorkBuddy 点文件在
// 编辑器里查看）。
// #OBS-15：markdown 文件用 renderMarkdown 渲染成真 Markdown（标题/列表/代码块/链接/表格），
// 不再退化成纯文本；json 也进高亮。其余（txt/未知）纯文本展示。
//
// 函数组件范式：折叠态用 useState；「按语言渲染正文」下沉为模块级函数（纯渲染分支）；
// 「语言分类」判据继续复用 FileKindClassifier（零 React，可单测）。

import { React } from '../../deps.js';
import { highlightCode, langOf } from '../../highlight.js';
import { renderMarkdown } from '../../format.js';
import type { FileView } from '../../shared.js';
import { FileKindClassifier } from '../../models/FileKindClassifier.js';

/** FileTab 组件的入参。 */
export interface FileTabProps {
  /** 待预览文件；为 null 时展示引导文案。 */
  fileView: FileView | null;
}

/** 右侧面板打开的非代码内容也按此限制展示文本（防止超长文件卡死渲染）。 */
const MAX_PREVIEW = 40000;

/**
 * 按语言渲染正文：代码走高亮，markdown 走渲染器，其余纯文本。
 * @param fileView 文件视图（含内容与语言）
 * @returns 正文节点；内容为空时返回 null
 */
function renderBody(fileView: FileView): ReactElement | null {
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

/**
 * 文件面板：可折叠的文件内容预览（标题行点击切换展开 / 收起）。
 * @param props 组件入参
 * @returns 文件面板节点（无文件时为引导文案）
 */
export function FileTab(props: FileTabProps): ReactElement {
  const { fileView } = props;
  const [open, setOpen] = React.useState<boolean>(true);
  /** 切换展开 / 收起。 */
  const toggle = (): void => setOpen((prev) => !prev);

  if (!fileView) {
    return (
      <div className="empty">
        在左侧文件树点击文件、或点击产物卡片的「打开」即可在此查看内容。
      </div>
    );
  }
  return (
    <div className="file-pane">
      <div
        className="file-row"
        onClick={toggle}
        title={open ? '收起' : '展开查看内容'}
      >
        <span className="file-caret">{open ? '▾' : '▸'}</span>
        <span className="file-name">{fileView.title}</span>
        <span className="file-meta">{fileView.meta}</span>
      </div>
      {open ? renderBody(fileView) : null}
    </div>
  );
}
