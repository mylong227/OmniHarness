// 文件面板：点击文件树节点后在右侧显示文件内容，可展开/收缩查看细节。

import { html, React } from '../../deps.js';
import type { FileView } from '../../shared.js';

export interface FileTabProps {
  fileView: FileView | null;
}

export function FileTab(props: FileTabProps): ReactElement {
  const { fileView } = props;
  const [open, setOpen] = React.useState(true);

  if (!fileView) {
    return html`<div className="empty">在左侧文件树点击文件即可在此查看内容。</div>`;
  }

  return html`<div className="file-pane">
    <div className="file-row" onClick=${() => setOpen((o) => !o)} title=${open ? '收起' : '展开查看内容'}>
      <span className="file-caret">${open ? '▾' : '▸'}</span>
      <span className="file-name">${fileView.title}</span>
      <span className="file-meta">${fileView.meta}</span>
    </div>
    ${open
      ? html`<pre className="file-content">${fileView.content}</pre>`
      : null}
  </div>`;
}
