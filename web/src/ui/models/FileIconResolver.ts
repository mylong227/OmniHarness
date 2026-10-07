// 文件图标：按 mediaType 选择图标，供文件选择器与附件列表展示。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

import type { IconName } from './Icon.js';

/** 文件图标解析器。 */
export class FileIconResolver {
  /**
   * 按媒体类型返回**自研线性图标名**。
   * 未知类型回落到回形针（fail-closed 到中性图标，不返回空）。
   *
   * 为什么不返回 emoji（曾有 `emoji()` 方法，2026-10-07 删除）：emoji 的字形由系统字体决定
   * （跨平台不一致）、尺寸与基线不受控、且不跟随 `currentColor`（hover / 选中态无法与文字同色）。
   * 口径由 `web/test/iconPolicy.test.mjs` 机械把守。
   * @param mediaType 媒体类型（MIME）
   * @returns 图标名（喂给 models/Icon.js 的 `icon()`）
   */
  public static iconName(mediaType: string): IconName {
    const t = (mediaType || '').toLowerCase();
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    if (t.startsWith('text/')) return 'file';
    if (t.includes('pdf')) return 'book';
    if (t.includes('zip') || t.includes('tar') || t.includes('gzip')) return 'archive';
    return 'paperclip';
  }
}
