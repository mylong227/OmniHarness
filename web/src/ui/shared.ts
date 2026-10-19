// 组件层共享的 UI 状态类型（与后端协议无关，仅描述前端渲染所需的结构）。

import type { GraphRunState, ThreadEvent } from '../types/models.ts';

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
  /** 有效时长（ms，服务端已剔除 >5 分钟的挂机间隔；历史会话可能没有）。 */
  activeMs?: number;
  /** 被剔除的空闲间隔个数（用户离开后再回来）。 */
  idleGaps?: number;
  /** 是否 mock/演示会话（服务端默认已过滤，显式 includeMock 时可能出现在列表里）。 */
  mock?: boolean;
  /** 创建会话时的模型名（服务端新存档才有）。 */
  model?: string;
  /** 服务端真实运行态（runTurn 进行中）；缺省视为空闲。 */
  running?: boolean;
  /** 是否已归档（侧车标记）：归档会话在左栏折叠到「已归档」组，可随时恢复。 */
  archived?: boolean;
}

export interface FileView {
  title: string;
  meta: string;
  content: string;
  /** 语言 id（'js'|'ts'|'json'|...），空串表示未知 → 纯文本展示。右侧文件面板据此做语法高亮。 */
  lang?: string;
}

/** 工具结果视图：事件流里内联展示的成功/失败与输出文本。 */
export interface ToolResultView {
  text: string;
  ok: boolean;
}

/**
 * 右栏「网页」标签的状态（内置浏览器，2026-10-19）。
 *
 * 与文件标签共享右栏容器，但**不共享** FileView：网页有地址、需要重载、可以没有内容；
 * 把两者塞进一个联合类型会让文件标签的合并/回落规则（FileTabs）被迫理解 iframe 语义。
 */
export interface BrowserView {
  /** 网页标签是否存在（关闭标签后为 false，地址保留以便再次打开）。 */
  open: boolean;
  /** 当前右栏显示的是网页还是文件（文件标签点击会把这里置 false）。 */
  active: boolean;
  /** iframe 当前地址（空串 = 还没导航，显示空态引导）。 */
  url: string;
  /** 标签标题（主机名或工作区文件名；只在展示层用）。 */
  title: string;
  /** 重载计数器：变化即重建 iframe（跨源页面无法调用其 history/reload）。 */
  reloadKey: number;
  /** 最近一次导航失败的可读原因（成功为空串）。 */
  error: string;
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

/**
 * 输入框回填指令（F4「编辑重发」）：把末条用户消息填回底部输入框。
 * nonce 单调递增，保证「文本与上一次相同」时也能触发一次新的回填。
 */
export interface ComposerSeed {
  /** 待回填文本。 */
  text: string;
  /** 回填序号：变化即触发一次回填。 */
  nonce: number;
}

export type { GraphRunState, ThreadEvent };
