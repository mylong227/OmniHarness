// 底部输入区（本实现风格）：多模态粘贴/拖拽/选择（图片·视频·文件）+ 模型切换 + 推理强度切换
// + AI 权限等级切换 + @mention 文件引用 + 语音输入。
// 附件随消息经 turns.run 的 images / files 字段送入后端，开关经 config.update 持久化。
//
// ## 结构（S2 长函数清偿后）
//
// 本文件只留「组合 + 工具条」两件事：
// - `Composer`：薄组合（函数体 ~50 行，上限 80）——建 textarea ref、接三个 hook、渲染输入卡片与两个弹窗；
// - `ComposerToolbar`：控制行（AddMenu / 权限 / 模型·强度 / 语音 / 发送）。
//
// 其余下沉到 `./composer/`：
// - 纯逻辑：`composerCompletions`（两类补全的态与文本改写）、`composerFiles`（剪贴板/拖拽/拆分）、
//   `composerLabels`（占位符与 busy 发送文案）、`composerKeyboard`（方向键/Enter 接管）；
// - hooks：`useComposerCompletions`（@ 与 / 的状态与拉取）、`useComposerAttachments`（附件与发送）、
//   `useComposerVoice`（语音识别）；
// - 展示：`ComposerInput`（正文 + 补全弹层）、`ComposerAttachments`（附件条）、
//   `ComposerSendControls`（发送 / 停止）。
//
// 函数组件范式保持不变：交互字段各一个 useState（在 hooks 内），文本域与识别器各一个 useRef，
// 卸载时停录音的清理由空依赖 effect 承接。

import * as React from 'react';
import { ModelPicker } from './ModelPicker.tsx';
import { FilePicker } from './FilePicker.tsx';
import { WorkIndicator } from './WorkIndicator.tsx';
import { AddMenu } from './AddMenu.tsx';
import { PermissionPicker } from './PermissionPicker.tsx';
import type { ChatQueueView } from '../models/ChatMessageQueue.ts';
import { icon } from '../models/Icon.ts';
import { SpeechRecognitionFactory } from '../models/SpeechRecognitionFactory.ts';
import type { FileAttachment } from '../../types/models.ts';
import type { ComposerSeed } from '../shared.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import { t } from '../i18n/i18n.ts';
import { PICKER_ERR_BOX, placeholderOf } from './composer/composerLabels.ts';
import { ComposerAttachments } from './composer/ComposerAttachments.tsx';
import { ComposerInput } from './composer/ComposerInput.tsx';
import { ComposerSendControls } from './composer/ComposerSendControls.tsx';
import { useComposerCompletions, useComposerSeed } from './composer/useComposerCompletions.ts';
import {
  useComposerAttachments,
  type ComposerAttachmentsApi,
} from './composer/useComposerAttachments.ts';
import { useComposerVoice, type ComposerVoiceApi } from './composer/useComposerVoice.ts';

/** Composer 组件的入参。 */
export interface ComposerProps {
  model: string;
  /** 当前厂商可用模型清单（服务端 model.catalog 下发；缺省用内置兜底）。 */
  modelOptions?: string[];
  /** 当前厂商展示名（下拉标题显示「模型 · DeepSeek」）。 */
  providerLabel?: string;
  reasoning: string;
  /** 当前厂商合法的 reasoning_effort 档位（三态语义见 ComposerOptions.reasoning / ladder）。 */
  reasoningOptions?: string[];
  permission: string;
  /** 当前会话 id（目标 / 计划 / 绘图模式按会话持久化；上下文容量报告维度）。 */
  threadId?: string | null;
  /**
   * 队列模式的排队消息坞（2026-10-31）：内含当前聊天模式、排队项与删除/置顶/清空回调。
   * 缺省（undefined）时不渲染坞——测试与无队列场景无需构造它。
   */
  queue?: ChatQueueView;
  /**
   * 输入框回填指令（F4「编辑重发」）：nonce 变化即把 text 写回输入框并聚焦。
   * 组件保持非受控，回填由 effect 直接写 DOM 值（见 ComposerDraft）。
   */
  seed?: ComposerSeed | null;
  /** 应用会话模式（转发给 AddMenu；控制器决定立即落盘还是暂存）。 */
  onApplyMode?: (patch: {
    goal?: string;
    planMode?: boolean;
    sketchMode?: boolean;
  }) => Promise<'applied' | 'deferred'>;
  /** 轻提示（AddMenu / 容量面板加载失败等）。 */
  onToast?: (msg: string, kind?: 'info' | 'err') => void;
  /** 跳到右侧某面板（AddMenu 点插件时打开「插件」页）。 */
  onOpenTab?: (key: string) => void;
  /** 打开文件（AddMenu 搜索命中为文件时）。 */
  onOpenFile?: (path: string) => void;
  /** 加载历史会话（AddMenu 搜索命中为聊天时）。 */
  onLoadThread?: (id: string) => void;
  onModelChange: (v: string) => void;
  onReasoningChange: (v: string) => void;
  onPermissionChange: (v: string) => void;
  onSend: (
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ) => void;
  /** 停止在跑回合（busy 时由停止按钮触发，业界常见的 stop）。 */
  onStop?: () => void;
  /** ApiClient（附件 FilePicker 走 attach.read 读 base64 用）。 */
  api: ApiClient;
  disabled?: boolean;
  /** 回合进行中（agent 正在干活）——显示工作状态条。 */
  busy?: boolean;
  /** 当前正在调用的工具名（无则显示"思考中"）。 */
  activeTool?: string | null;
}

/** 输入区工具条（控制行）的入参。 */
interface ComposerToolbarProps {
  /** 组件属性（模型 / 权限 / 回调等整体透传）。 */
  readonly props: ComposerProps;
  /** 附件接口（「+」菜单要打开 FilePicker）。 */
  readonly attachments: ComposerAttachmentsApi;
  /** 语音接口（麦克风按钮的开关与态）。 */
  readonly voice: ComposerVoiceApi;
}

/**
 * 控制行：左侧「+」与会话模式、权限档位；右侧模型·强度、语音、发送 / 停止。
 * @param p 组件入参
 * @returns 控制行节点
 */
function ComposerToolbar(p: ComposerToolbarProps): ReactElement {
  const c = p.props;
  return (
    <div className="composer-bar">
      <div className="composer-bar-left">
        <AddMenu
          threadId={c.threadId ?? ''}
          api={c.api}
          onAttach={p.attachments.openPicker}
          onToast={(m, k) => c.onToast?.(m, k)}
          onApplyMode={c.onApplyMode}
          onOpenTab={(key) => c.onOpenTab?.(key)}
          onOpenFile={(path) => c.onOpenFile?.(path)}
          onLoadThread={(id) => c.onLoadThread?.(id)}
        />
        <PermissionPicker permission={c.permission} onPick={c.onPermissionChange} api={c.api} />
      </div>
      <div className="composer-bar-right">
        {/* 容量入口已于 2026-10-28 移入控制台「上下文」面板（用户：不要挤输入区）。
            这里只留"要动手"的控件：权限 / 模型 / 语音 / 发送。 */}
        {/* 模型与推理强度合并为一个入口（2026-10-17）：强度不再是输入行里并排的第二个下拉，
            而是弹窗内的进度条——两者本就是同一个决定的两半，且强度是有序量。
            原先这里有两个 Dropdown（"推理强度" + "模型"），是输入行最宽的两块 chrome。 */}
        <ModelPicker
          model={c.model}
          {...(c.modelOptions !== undefined ? { modelOptions: c.modelOptions } : {})}
          reasoning={c.reasoning}
          {...(c.reasoningOptions !== undefined ? { reasoningOptions: c.reasoningOptions } : {})}
          {...(c.providerLabel ? { providerLabel: c.providerLabel } : {})}
          onModelChange={c.onModelChange}
          onReasoningChange={c.onReasoningChange}
        />
        {SpeechRecognitionFactory.supported() ? (
          <button
            className={'iconbtn mic' + (p.voice.listening ? ' listening' : '')}
            title={p.voice.listening ? t('停止语音输入') : t('语音输入（中文）')}
            aria-label={p.voice.listening ? t('停止语音输入') : t('开始语音输入')}
            onClick={p.voice.toggle}
          >
            {icon(p.voice.listening ? 'x' : 'mic', { size: 15 })}
          </button>
        ) : null}
        <ComposerSendControls
          busy={c.busy}
          mode={c.queue?.mode}
          disabled={c.disabled}
          onSend={p.attachments.send}
          onStop={c.onStop}
        />
      </div>
    </div>
  );
}

/**
 * 输入区组件。
 * @param props 组件属性。
 * @returns 输入区节点。
 */
export function Composer(props: ComposerProps): ReactElement {
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const completions = useComposerCompletions({ api: props.api, taRef });
  const attachments = useComposerAttachments({
    api: props.api,
    taRef,
    onSend: props.onSend,
    clearSuggest: completions.clearSuggest,
  });
  const voice = useComposerVoice(taRef);
  useComposerSeed(props.seed, taRef, completions.clearSuggest);

  return (
    <div
      className="composer"
      role="region"
      aria-label={t('任务输入区')}
      onDragOver={(e: React.DragEvent) => e.preventDefault()}
      onDrop={attachments.onDrop}
    >
      {props.busy === true ? <WorkIndicator activeTool={props.activeTool ?? null} /> : null}
      {/* 输入卡片：正文在上、控制行在下（截图式 Composer 的版式）。 */}
      <div className="composer-box">
        <ComposerInput
          taRef={taRef}
          placeholder={placeholderOf(props.busy, props.queue?.mode)}
          completions={completions}
          onPaste={attachments.onPaste}
          onSubmit={attachments.send}
        />
        <ComposerAttachments
          attachments={attachments.attachments}
          onRemove={attachments.removeAt}
        />
        <ComposerToolbar props={props} attachments={attachments} voice={voice} />
      </div>

      {attachments.pickerErr ? (
        <div className="fp-err" style={PICKER_ERR_BOX}>
          {attachments.pickerErr}
        </div>
      ) : null}
      {attachments.filePickerOpen ? (
        <FilePicker
          api={props.api}
          onCancel={attachments.closePicker}
          onPick={attachments.pickFiles}
        />
      ) : null}
    </div>
  );
}
