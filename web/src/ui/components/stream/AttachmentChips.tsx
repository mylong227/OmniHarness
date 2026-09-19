// 附件 chip：用户/助手消息携带的文件以内联 chip 展示。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import { FileIconResolver } from '../../models/FileIconResolver.js';
import type { FileAttachment } from '../../../types/models.js';

/** AttachmentChips 组件的入参。 */
export interface AttachmentChipsProps {
  /** 消息携带的附件（缺省或空数组时渲染为 null）。 */
  files?: FileAttachment[];
}

/**
 * 附件 chip：把附件清单渲染为图标 + 文件名的一行 chip。
 * @param props 组件入参
 * @returns chip 容器节点；无附件时返回 null
 */
export function AttachmentChips(props: AttachmentChipsProps): ReactElement | null {
  const { files } = props;
  if (!files || files.length === 0) return null;
  return (
    <div className="ev-attachments">
      {files.map((f) => (
        <span className="ev-chip" key={f.name + (f.data ?? f.url ?? '').slice(0, 10)}>
          <span className="ev-chip-ico">{FileIconResolver.emoji(f.mediaType)}</span>
          <span className="ev-chip-name">{esc(f.name)}</span>
        </span>
      ))}
    </div>
  );
}
