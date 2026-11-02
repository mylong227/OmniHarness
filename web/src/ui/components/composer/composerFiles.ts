// 输入区附件的纯逻辑：剪贴板 / 拖拽 → File 清单，草稿按图片·文件拆分。
//
// 抽成模块级函数的理由与 ComposerOptions 同源：组件体内只留 React 状态与接线，
// 这些换算（含桌面桥的路径决策，见 models/AttachmentDrop）不碰 hooks，便于单测。

import type * as React from 'react';
import { pathsForDrop } from '../../models/AttachmentDrop.ts';
import { desktopBridge } from '../../../core/desktop/DesktopBridge.ts';
import type { AttachmentDraft } from '../../models/AttachmentIcon.ts';
import type { FileAttachment } from '../../../types/models.ts';

/** 拖拽落点的解析结果。 */
export interface DropFiles {
  /** 浏览器文件清单（回落到浏览器读时用）。 */
  readonly files: FileList;
  /** 桌面桥给出的真实路径；null = 整批回落浏览器读（决策见 AttachmentDrop）。 */
  readonly paths: readonly string[] | null;
}

/**
 * 从剪贴板事件里取出文件项（非文件项忽略）。
 * @param e 剪贴板事件
 * @returns 文件清单（无文件时为空数组）
 */
export function filesFromClipboard(e: React.ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return [];
  const files: File[] = [];
  for (const it of Array.from(items)) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

/**
 * 从拖拽事件里取文件清单与真实路径。
 *
 * 桌面桥能给出真实路径时优先走服务端 `attach.read`（与 FilePicker 同通道）；
 * 拿不到（浏览器 / 虚拟文件 / 桥降级）才回落浏览器读——决策在 `AttachmentDrop`。
 * @param e 拖拽事件
 * @returns 解析结果；没有文件时 null
 */
export function filesFromDrop(e: React.DragEvent): DropFiles | null {
  const dt = e.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return null;
  const paths = pathsForDrop(Array.from(dt.files), desktopBridge()?.pathForFile);
  return { files: dt.files, paths };
}

/**
 * 把附件草稿按图片 / 文件拆入两个出口数组（与 `FileAttachment` 形状同源，就地写避免分配）。
 * @param drafts 附件草稿
 * @param images 图片出口
 * @param files 文件出口
 * @returns 无
 */
export function splitComposerAttachments(
  drafts: readonly AttachmentDraft[],
  images: { data?: string; mediaType?: string }[],
  files: FileAttachment[],
): void {
  for (const a of drafts) {
    const base = { name: a.name, mediaType: a.mediaType, data: a.data };
    if (a.kind === 'image') images.push(base);
    else files.push(base);
  }
}
