// 组件层共享的 UI 状态类型（与后端协议无关，仅描述前端渲染所需的结构）。

import type { GraphRunState, ThreadEvent } from '../types/models.js';

export interface ToolItem {
  callId: string;
  name: string;
  status: 'pending' | 'ok' | 'err';
}

export interface SessionEntry {
  id: string;
  label: string;
  /** 创建时的工作区（session_meta 标记；历史会话可能没有 → 归「更早会话」组）。 */
  workspace?: string;
  updatedAt?: string;
  turns?: number;
}

export interface FileView {
  title: string;
  meta: string;
  content: string;
  /** 语言 id（'js'|'ts'|'json'|...），空串表示未知 → 纯文本展示。右侧文件面板据此做语法高亮。 */
  lang?: string;
}

export type ToastKind = 'ok' | 'err' | 'info';

export interface ToastState {
  message: string;
  kind: ToastKind;
  visible: boolean;
}

export interface LiveInput {
  id: string;
  name: string;
  partial: string;
}

export type { GraphRunState, ThreadEvent };
