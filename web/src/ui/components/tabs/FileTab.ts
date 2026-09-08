// 文件面板：点击文件树节点 / 产物卡片 / markdown 文件链接后，在右侧显示文件内容。
// #OBS-14：代码类文件用内置 tokenizer 做语法高亮（分颜色，参考 WorkBuddy 点文件在
// 编辑器里查看），非代码（md/json 等）降级为纯文本 / 自带渲染。空行保持等宽对齐。

import { html, React } from '../../deps.js';
import { highlightCode, langOf } from '../../highlight.js';
import type { FileView } from '../../shared.js';

export interface FileTabProps {
  fileView: FileView | null;
}

/** 右侧面板打开的非代码内容也按此限制展示文本（防止超长文件卡死渲染）。 */
const MAX_PREVIEW = 40000;

export function FileTab(props: FileTabProps): ReactElement {
  const { fileView } = props;
  const [open, setOpen] = React.useState(true);

  if (!fileView) {
    return html`<div className="empty">在左侧文件树点击文件、或点击产物卡片的「打开」即可在此查看内容。</div>`;
  }

  const body = ((): ReactElement | null => {
    if (fileView.content === '') return null;
    const lang = fileView.lang || langOf(fileView.title);
    // #OBS-14：高亮代码只在真正是代码类型时走；md/json 等不在此着色（避免双渲染）。
    const codeLike =
      lang === 'js' || lang === 'jsx' || lang === 'ts' || lang === 'tsx' ||
      lang === 'css' || lang === 'html' || lang === 'sh' || lang === 'py' ||
      lang === 'rs' || lang === 'go' || lang === 'sql' || lang === 'java';
    if (codeLike) {
      return highlightCode(fileView.content.slice(0, MAX_PREVIEW), lang);
    }
    // 非代码类型退化纯文本（md 用 textContent 而非 renderMarkdown——右栏窄，渲染 markdown 反而挤）。
    return html`<pre className="file-content" spellCheck="false">${fileView.content}</pre>`;
  })();

  return html`<div className="file-pane">
    <div className="file-row" onClick=${() => setOpen((o) => !o)} title=${open ? '收起' : '展开查看内容'}>
      <span className="file-caret">${open ? '▾' : '▸'}</span>
      <span className="file-name">${fileView.title}</span>
      <span className="file-meta">${fileView.meta}</span>
    </div>
    ${open ? body : null}
  </div>`;
}
