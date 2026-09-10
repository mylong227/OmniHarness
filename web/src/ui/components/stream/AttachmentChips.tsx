// 附件 chip：用户/助手消息携带的文件以内联 chip 展示。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import { FileIconResolver } from '../../models/FileIconResolver.js';
import type { FileAttachment } from '../../../types/models.js';

export interface AttachmentChipsProps {
  files?: FileAttachment[];
}

/** 附件 chip 组件（无附件时渲染为 null）。 */
export class AttachmentChips extends React.Component<AttachmentChipsProps> {
  override render(): ReactElement | null {
    const { files } = this.props;
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
}
