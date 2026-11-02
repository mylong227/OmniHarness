// 附件条：缩略图 / 文件图标 + 移除按钮 + 体积。
//
// 原为 Composer 内的模块级 `renderAttachmentsView`；改成组件以统一「无附件即 null」的
// 渲染口径（DOM 结构与 class 名逐字段照搬，避免视觉回归）。

import { FileSizeFormatter } from '../../models/FileSizeFormatter.ts';
import { icon } from '../../models/Icon.ts';
import { AttachmentIcon, type AttachmentDraft } from '../../models/AttachmentIcon.ts';
import { t } from '../../i18n/i18n.ts';

/** 附件条的入参。 */
export interface ComposerAttachmentsProps {
  /** 附件草稿列表。 */
  readonly attachments: AttachmentDraft[];
  /** 移除回调（按 id）。 */
  readonly onRemove: (id: string) => void;
}

/**
 * 附件条：缩略图 / 文件图标 + 移除按钮 + 体积。
 * @param props 组件入参
 * @returns 附件条节点；无附件时为 null
 */
export function ComposerAttachments(props: ComposerAttachmentsProps): ReactElement | null {
  const { attachments, onRemove } = props;
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((a) => (
        <div className={'att att-' + a.kind} key={a.id}>
          {a.kind === 'image' && a.previewUrl ? (
            <img className="att-thumb" src={a.previewUrl} alt={a.name} />
          ) : null}
          {a.kind === 'video' && a.previewUrl ? (
            <video className="att-thumb" src={a.previewUrl} controls preload="metadata" />
          ) : null}
          {a.kind === 'file' ? (
            <div className="att-file">
              <span className="att-ico">{icon(AttachmentIcon.iconName(a.mediaType), { size: 15 })}</span>
              <span className="att-name">{a.name}</span>
            </div>
          ) : null}
          <button className="att-x" title={t('移除')} onClick={() => onRemove(a.id)}>
            ×
          </button>
          <span className="att-size">{a.size === undefined ? '' : FileSizeFormatter.human(a.size)}</span>
        </div>
      ))}
    </div>
  );
}
