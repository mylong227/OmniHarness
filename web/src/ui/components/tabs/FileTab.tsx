// 文件面板：点击文件树节点 / 产物卡片 / markdown 文件链接后，在右栏代码查看器显示内容。
// #OBS-14：代码类文件用内置 tokenizer 做语法高亮 + 行号 gutter（CodeSurface）。
// #OBS-15：markdown 文件用 renderMarkdown 渲染成真 Markdown；json 键值分色；其余纯文本。
//
// 2026-10-07 用户实测反馈后重塑：去掉组件自带的「可折叠标题行」（路径栏已显示同名信息，
// 双重标题是冗余）；正文改为**填满面板高度**（原先内容下方是一大块空白，观感是"断了的页面"）。
//
// 函数组件范式：「按语言渲染正文」下沉为模块级函数（纯渲染分支）；
// 「语言分类」判据复用 FileKindClassifier（零 React，可单测）。

import { React } from '../../deps.js';
import { highlightCode, langOf } from '../../highlight.js';
import { renderMarkdown, emptyState } from '../../format.js';
import type { FileView } from '../../shared.js';
import { FileKindClassifier } from '../../models/FileKindClassifier.js';
import { CodeSurface } from '../CodeSurface.js';
import { icon } from '../../models/Icon.js';

/** FileTab 组件的入参。 */
export interface FileTabProps {
  /** 待预览文件；为 null 时展示引导文案。 */
  fileView: FileView | null;
}

/** 右侧面板打开的非代码内容也按此限制展示文本（防止超长文件卡死渲染）。 */
const MAX_PREVIEW = 40000;

/**
 * 按语言渲染正文：代码走 CodeSurface（高亮 + 行号），markdown 走渲染器，其余纯文本。
 * @param fileView 文件视图（含内容与语言）
 * @returns 正文节点；内容为空时返回 null
 */
function renderBody(fileView: FileView): ReactElement | null {
  if (fileView.content === '') return null;
  const lang = fileView.lang || langOf(fileView.title);
  const clipped = fileView.content.slice(0, MAX_PREVIEW);
  if (FileKindClassifier.isCode(lang)) {
    return <CodeSurface content={clipped} lang={lang} />;
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
 * 文件面板：填满面板高度的文件内容预览（标题 / 元信息由代码查看器的路径栏呈现）。
 * @param props 组件入参
 * @returns 文件面板节点（无文件时为引导文案）
 */
export function FileTab(props: FileTabProps): ReactElement {
  const { fileView } = props;
  if (!fileView) {
    return (
      emptyState(
        icon('file', { size: 20 }),
        '还没有打开文件',
        '在左侧文件树点击文件、或点产物卡片的「打开」，内容会显示在这里。',
      )
    );
  }
  return <div className="file-pane">{renderBody(fileView)}</div>;
}
