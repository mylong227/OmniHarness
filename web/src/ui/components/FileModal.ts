// 文件预览弹窗：点击文件树节点时在 App 层置位 fileView，本组件负责展示。

import { html } from '../deps.js';
import type { FileView } from '../shared.js';

export interface FileModalProps {
  fileView: FileView | null;
  onClose: () => void;
}

/** 静态样式对象：React 的 style 必须是「属性→值」映射，不能传 CSS 字符串。 */
const HIDDEN: Record<string, string> = { display: 'none' };
const MODAL_BOX: Record<string, string> = { width: '720px', maxWidth: '94vw' };
const CODE_BOX: Record<string, string> = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  padding: '10px 12px',
  fontSize: '12px',
  lineHeight: '1.5',
  maxHeight: '56vh',
  overflow: 'auto',
  whiteSpace: 'pre',
  fontFamily: 'ui-monospace, Menlo, monospace',
};

export function FileModal(props: FileModalProps): ReactElement {
  const { fileView, onClose } = props;
  if (!fileView) return html`<div className="overlay" style=${HIDDEN}></div>`;
  return html`<div className="overlay show">
    <div className="modal" style=${MODAL_BOX}>
      <h3>${fileView.title}</h3>
      <div className="meta">${fileView.meta}</div>
      <pre style=${CODE_BOX}>${fileView.content}</pre>
      <div className="actions">
        <button className="always" onClick=${onClose}>关闭</button>
      </div>
    </div>
  </div>`;
}
