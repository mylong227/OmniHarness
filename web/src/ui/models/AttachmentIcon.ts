// 附件图标与草稿构建：Composer 附件区用（与文件浏览器的图标语义略有差异，故独立成类）。

import type { FileAttachment } from '../../types/models.js';

/** 本地草稿附件（含预览 URL，仅前端使用）。 */
export interface AttachmentDraft extends FileAttachment {
  id: string;
  kind: 'image' | 'video' | 'file';
  previewUrl?: string;
  size?: number;
}

/** 服务端 attach.read 返回的单个文件。 */
export interface RemoteFile {
  name: string;
  mediaType: string;
  data: string;
  kind: string;
  size: number;
}

/** 附件图标解析器（文件类附件展示用）。 */
export class AttachmentIcon {
  /** 按媒体类型给图标；未知回落回形针。 */
  static of(mediaType: string): string {
    const t = (mediaType || '').toLowerCase();
    if (t.startsWith('video/')) return '🎬';
    if (t.startsWith('audio/')) return '🎵';
    if (t.startsWith('image/')) return '🖼';
    if (t.includes('pdf')) return '📕';
    if (t.includes('zip') || t.includes('tar')) return '🗜';
    if (t.includes('json') || t.includes('javascript') || t.includes('typescript')) return '📜';
    return '📎';
  }
}

/** 附件草稿构建器。 */
export class AttachmentDraftFactory {
  /** 浏览器 File → 草稿（走 FileReader 读 dataURL，取逗号后的 base64 段）。 */
  static fromFile(file: File, id: string): Promise<AttachmentDraft> {
    const kind: AttachmentDraft['kind'] = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : 'file';
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const comma = dataUrl.indexOf(',');
        resolve({
          id,
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          data: comma >= 0 ? dataUrl.slice(comma + 1) : '',
          kind,
          previewUrl: dataUrl,
          size: file.size,
        });
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * 服务端 attach.read 结果 → 草稿。
   * kind 只认 image/video，其余（含 audio，前端无预览控件）归 file。
   */
  static fromRemote(f: RemoteFile, id: string): AttachmentDraft {
    const kind: AttachmentDraft['kind'] = f.kind === 'image' || f.kind === 'video' ? f.kind : 'file';
    return {
      id,
      name: f.name,
      mediaType: f.mediaType,
      data: f.data,
      kind,
      previewUrl: kind === 'file' ? undefined : `data:${f.mediaType};base64,${f.data}`,
      size: f.size,
    };
  }
}
