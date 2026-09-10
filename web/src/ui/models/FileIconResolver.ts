// 文件图标：按 mediaType 选择 emoji，供文件选择器与附件列表展示。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 文件图标解析器。 */
export class FileIconResolver {
  /** 按媒体类型返回图标；未知类型回落到回形针（fail-closed 到中性图标，不返回空）。 */
  static emoji(mediaType: string): string {
    const t = (mediaType || '').toLowerCase();
    if (t.startsWith('image/')) return '🖼';
    if (t.startsWith('video/')) return '🎬';
    if (t.startsWith('audio/')) return '🎵';
    if (t.startsWith('text/')) return '📄';
    if (t.includes('pdf')) return '📕';
    if (t.includes('zip') || t.includes('tar') || t.includes('gzip')) return '🗜';
    return '📎';
  }
}
