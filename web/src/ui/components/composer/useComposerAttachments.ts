// 输入区附件 hook：草稿清单 + 粘贴 / 拖拽 / FilePicker 三条入口 + 发送。
//
// 拆自 Composer（S2 长函数清偿）：原组件里附件相关的 8 个闭包共 ~110 行。
// 现在文件读取（浏览器 File / 服务端 attach.read）在 `useAttachmentLoaders`，
// 本 hook 只留交互状态与事件接线；纯换算在 `composerFiles.ts`。

import * as React from 'react';
import {
  AttachmentDraftFactory,
  type AttachmentDraft,
  type RemoteFile,
} from '../../models/AttachmentIcon.ts';
import type { FileAttachment } from '../../../types/models.ts';
import type { ApiClient } from '../../../core/ApiClient.ts';
import { t } from '../../i18n/i18n.ts';
import { growComposerTextarea } from './composerCompletions.ts';
import { filesFromClipboard, filesFromDrop, splitComposerAttachments } from './composerFiles.ts';

/** 附件 hook 的入参。 */
export interface ComposerAttachmentsOptions {
  /** ApiClient（FilePicker 走 attach.read 读 base64）。 */
  readonly api: ApiClient;
  /** 非受控输入框引用（发送时读值并清空）。 */
  readonly taRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 发送上抛（路由由 ComposerController 按聊天模式分流）。 */
  readonly onSend: (
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ) => void;
  /** 收起补全（发送后清场）。 */
  readonly clearSuggest: () => void;
}

/** 附件接口（组件层只接这一个对象）。 */
export interface ComposerAttachmentsApi {
  readonly attachments: AttachmentDraft[];
  readonly filePickerOpen: boolean;
  readonly pickerErr: string | null;
  /** 粘贴：从中取文件附件。 */
  readonly onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** 拖拽落点：取文件附件。 */
  readonly onDrop: (e: React.DragEvent) => void;
  /** 移除单个附件。 */
  readonly removeAt: (id: string) => void;
  /** 打开 FilePicker（先清掉上次的错误）。 */
  readonly openPicker: () => void;
  /** 关闭 FilePicker。 */
  readonly closePicker: () => void;
  /** FilePicker 选完：关弹窗并把路径交给 attach.read。 */
  readonly pickFiles: (paths: string[]) => void;
  /** 发送：附件按图片 / 文件拆分后上抛，并清空输入与草稿。 */
  readonly send: () => void;
}

/** 附件读取器（浏览器 File 与 attach.read 两个通道）。 */
interface AttachmentLoaders {
  /** 浏览器本地文件 → 附件草稿（粘贴 / 拖拽回落）。 */
  readonly addFiles: (list: FileList | File[]) => Promise<void>;
  /** FilePicker 选完文件：批量调 attach.read 转草稿（不走浏览器 FileReader）。 */
  readonly addRemoteFiles: (paths: string[]) => Promise<void>;
}

/**
 * 附件草稿读取：浏览器 FileReader 与服务端 attach.read 两条通道。
 * @param api ApiClient
 * @param setAttachments 草稿清单 setter
 * @param setPickerErr 读取错误 setter
 * @returns 两个读取入口
 */
function useAttachmentLoaders(
  api: ApiClient,
  setAttachments: React.Dispatch<React.SetStateAction<AttachmentDraft[]>>,
  setPickerErr: (err: string | null) => void,
): AttachmentLoaders {
  /**
   * 浏览器本地文件 → 附件草稿（粘贴 / 拖拽）。
   * @param list 文件清单
   * @returns 无
   */
  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const base = 'att' + Date.now();
    const drafts = await Promise.all(
      Array.from(list).map((f, i) => AttachmentDraftFactory.fromFile(f, base + '_' + i)),
    );
    setAttachments((prev) => [...prev, ...drafts]);
  };

  /**
   * FilePicker 选完文件：批量调 attach.read 转草稿（不走浏览器 FileReader）。
   * @param paths 选中路径
   * @returns 无
   */
  const addRemoteFiles = async (paths: string[]): Promise<void> => {
    setPickerErr(null);
    try {
      const r = await api.attachRead(paths);
      if (r.files.length === 0 && r.errors.length > 0) {
        setPickerErr(r.errors[0]?.error ?? t('附件读取失败'));
        return;
      }
      const base = 'att' + Date.now();
      const drafts = (r.files as RemoteFile[]).map((f, i) =>
        AttachmentDraftFactory.fromRemote(f, base + '_' + i),
      );
      setAttachments((prev) => [...prev, ...drafts]);
      if (r.errors.length > 0) {
        setPickerErr(
          t('{count} 个文件读取失败：{errors}', {
            count: r.errors.length,
            errors: r.errors.map((e) => e.error).join('；'),
          }),
        );
      }
    } catch (e) {
      setPickerErr(t('附件读取失败：{msg}', { msg: (e as Error).message }));
    }
  };

  return { addFiles, addRemoteFiles };
}

/**
 * 输入区附件：草稿状态 + 粘贴 / 拖拽 / 选择 / 发送。
 * @param o 入参（ApiClient + 输入框引用 + 发送与清场上抛）
 * @returns 附件接口
 */
export function useComposerAttachments(o: ComposerAttachmentsOptions): ComposerAttachmentsApi {
  const [attachments, setAttachments] = React.useState<AttachmentDraft[]>([]);
  const [filePickerOpen, setFilePickerOpen] = React.useState<boolean>(false);
  const [pickerErr, setPickerErr] = React.useState<string | null>(null);
  const loaders = useAttachmentLoaders(o.api, setAttachments, setPickerErr);

  /** 粘贴：从中取文件附件。 @returns 无 */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesFromClipboard(e);
    if (files.length === 0) return;
    e.preventDefault();
    void loaders.addFiles(files);
  };

  /** 拖拽落点：取文件附件（桌面桥有真实路径时走服务端 attach.read）。 @returns 无 */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const drop = filesFromDrop(e);
    if (drop === null) return;
    if (drop.paths !== null) {
      void loaders.addRemoteFiles([...drop.paths]);
      return;
    }
    void loaders.addFiles(drop.files);
  };

  /** 移除单个附件。 @param id 附件 id @returns 无 */
  const removeAt = (id: string): void => setAttachments((prev) => prev.filter((a) => a.id !== id));

  /** 打开 FilePicker（先清掉上次的错误）。 @returns 无 */
  const openPicker = (): void => {
    setPickerErr(null);
    setFilePickerOpen(true);
  };

  /** 关闭 FilePicker。 @returns 无 */
  const closePicker = (): void => setFilePickerOpen(false);

  /** FilePicker 选完：关弹窗并交给 attach.read。 @param paths 选中路径 @returns 无 */
  const pickFiles = (paths: string[]): void => {
    setFilePickerOpen(false);
    void loaders.addRemoteFiles(paths);
  };

  /** 发送：把附件按图片 / 文件拆分后上抛，并清空输入与草稿。 @returns 无 */
  const send = (): void => {
    const ta = o.taRef.current;
    if (!ta) return;
    const prompt = ta.value.trim();
    if (prompt === '' && attachments.length === 0) return;
    // 发送路由在 ComposerController：空闲=直接开跑；在飞=按聊天模式排队或插话
    // （2026-10-31 起两种模式都由控制器统一分流，输入区不再自己判断）。
    const images: { data?: string; mediaType?: string }[] = [];
    const files: FileAttachment[] = [];
    splitComposerAttachments(attachments, images, files);
    ta.value = '';
    growComposerTextarea(o.taRef.current);
    setAttachments([]);
    o.clearSuggest();
    o.onSend(prompt, images, files);
  };

  return {
    attachments,
    filePickerOpen,
    pickerErr,
    onPaste,
    onDrop,
    removeAt,
    openPicker,
    closePicker,
    pickFiles,
    send,
  };
}
