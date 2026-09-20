// 文件预览弹窗：点击文件树节点时在 App 层置位 fileView，本组件负责展示。
// 纯展示组件（函数组件范式）：关闭通过回调上抛，无内部状态、无副作用。

import { React } from '../deps.js';
import type { FileView } from '../shared.js';

/** FileModal 组件的入参。 */
export interface FileModalProps {
  /** 待预览的文件内容；为 null 时渲染为隐藏态遮罩。 */
  fileView: FileView | null;
  /** 关闭弹窗。 */
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

/**
 * 文件预览弹窗：渲染文件标题、元信息与内容，并提供关闭入口。
 * @param props 组件入参
 * @returns 弹窗节点（无待预览文件时为隐藏遮罩）
 */
export function FileModal(props: FileModalProps): ReactElement {
  const { fileView, onClose } = props;
  if (!fileView) return <div className="overlay" style={HIDDEN}></div>;
  return (
    <div className="overlay show">
      <div
        className="modal"
        style={MODAL_BOX}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fm-title"
        aria-describedby="fm-meta"
      >
        <h3 id="fm-title">{fileView.title}</h3>
        <div className="meta" id="fm-meta">
          {fileView.meta}
        </div>
        <pre style={CODE_BOX}>{fileView.content}</pre>
        <div className="actions">
          <button className="always" aria-label="关闭文件预览" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
