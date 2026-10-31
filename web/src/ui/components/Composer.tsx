// 底部输入区（本实现风格）：多模态粘贴/拖拽/选择（图片·视频·文件）+ 模型切换 + 推理强度切换
// + AI 权限等级切换 + @mention 文件引用 + 语音输入。
// 附件随消息经 turns.run 的 images / files 字段送入后端，开关经 config.update 持久化。
//
// 面向对象改造：
// - 下拉选项构建 → ComposerOptions；@mention 解析 → MentionResolver；
//   文件树扁平化 → FileTreeFlattener；语音识别 → SpeechRecognitionFactory / SpeechTranscript；
//   附件草稿 → AttachmentDraftFactory / AttachmentIcon；工作条 → WorkIndicator 组件。
// - 组件自身只保留交互状态（附件 / 选择器 / 补全 / 录音）与 DOM 引用。
//
// 函数组件范式：6 个交互字段各一个 useState；文本域与识别器各一个 useRef；
// 卸载时停录音的清理由空依赖 effect 承接（原 componentWillUnmount）；
// 附件条 / @补全弹层的渲染下沉为模块级纯函数。

import * as React from 'react';
import { ModelPicker } from './ModelPicker.tsx';
import { FilePicker } from './FilePicker.tsx';
import { WorkIndicator } from './WorkIndicator.tsx';
import { AddMenu } from './AddMenu.tsx';
import { PermissionPicker } from './PermissionPicker.tsx';
import type { ChatQueueView } from '../models/ChatMessageQueue.ts';
import { MentionResolver } from '../models/MentionResolver.ts';
import { SlashResolver, type SlashToken } from '../models/SlashResolver.ts';
import { ComposerDraft } from '../models/ComposerDraft.ts';
import { FileTreeFlattener } from '../models/FileTreeFlattener.ts';
import { FileSizeFormatter } from '../models/FileSizeFormatter.ts';
import { pathsForDrop } from '../models/AttachmentDrop.ts';
import { desktopBridge } from '../../core/desktop/DesktopBridge.ts';
import { icon } from '../models/Icon.ts';
import {
  SpeechRecognitionFactory,
  SpeechTranscript,
  type SpeechRecognitionLike,
} from '../models/SpeechRecognitionFactory.ts';
import {
  AttachmentDraftFactory,
  AttachmentIcon,
  type AttachmentDraft,
  type RemoteFile,
} from '../models/AttachmentIcon.ts';
import type { FileAttachment } from '../../types/models.ts';
import type { ComposerSeed } from '../shared.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import { t } from '../i18n/i18n.ts';

const PICKER_ERR_BOX: Record<string, string> = { margin: '6px 14px 0' };

/**
 * 输入框随内容增高：空态一行，最多 140px（与 CSS max-height 一致）。
 *
 * 非受控 textarea 在输入 / @ 回填 / 语音写入 / 发送清空后都要重算，否则高度会停在旧值。
 * @param ta 目标输入框（尚未挂载时传 null）
 * @returns 无
 */
function growComposerTextarea(ta: HTMLTextAreaElement | null): void {
  if (ta === null) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

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

/** @mention 补全态。 */
interface MentionState {
  /** `@` 在输入框全文中的下标。 */
  start: number;
  items: string[];
  idx: number;
}

/** `/` 技能候选。 */
interface SkillOption {
  name: string;
  description: string;
  tags: string[];
}

/** `/` 技能补全态。 */
interface SlashState {
  /** 当前 token（选中后用于替换）。 */
  token: SlashToken;
  items: SkillOption[];
  idx: number;
}

/**
 * `/` 技能补全弹层：名称 + 描述，点击插入 `/name `。
 * @param slash 补全态
 * @param onPick 选中回调
 * @returns 弹层节点；无补全时为 null
 */
function renderSlashView(
  slash: SlashState | null,
  onPick: (item: SkillOption) => void,
): ReactElement | null {
  if (slash === null) return null;
  return (
    <div className="mention-pop" role="listbox" aria-label={t('技能补全')}>
      {slash.items.map((item, i) => (
        <div
          key={item.name}
          role="option"
          aria-selected={i === slash.idx}
          className={'mention-item' + (i === slash.idx ? ' active' : '')}
          title={item.description}
          onMouseDown={(e: React.MouseEvent) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="slash-name">/{item.name}</span>
          <span className="slash-desc">{item.description}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 附件条：缩略图 / 文件图标 + 移除按钮 + 体积。
 * @param attachments 附件草稿列表
 * @param onRemove 移除回调（按 id）
 * @returns 附件条节点；无附件时为 null
 */
function renderAttachmentsView(
  attachments: AttachmentDraft[],
  onRemove: (id: string) => void,
): ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((a) => (
        <div className={'att att-' + a.kind} key={a.id}>
          {a.kind === 'image' && a.previewUrl ? <img className="att-thumb" src={a.previewUrl} alt={a.name} /> : null}
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

/**
 * @mention 补全弹层：列出候选路径，点击（mousedown 防失焦）即插入。
 * @param mention 补全态
 * @param onPick 选中回调
 * @returns 弹层节点；无补全时为 null
 */
function renderMentionView(mention: MentionState | null, onPick: (p: string) => void): ReactElement | null {
  if (mention === null) return null;
  return (
    <div className="mention-pop" role="listbox" aria-label={t('文件引用补全')}>
      {mention.items.map((p, i) => (
        <div
          key={p}
          role="option"
          aria-selected={i === mention.idx}
          className={'mention-item' + (i === mention.idx ? ' active' : '')}
          title={'@' + p}
          onMouseDown={(e: React.MouseEvent) => {
            e.preventDefault();
            onPick(p);
          }}
        >
          @{p}
        </div>
      ))}
    </div>
  );
}

/**
 * 把附件草稿按图片 / 文件拆入两个出口数组（与 `FileAttachment` 形状同源，就地写避免分配）。
 * @param drafts 附件草稿。
 * @param images 图片出口。
 * @param files 文件出口。
 * @returns 无
 */
function splitComposerAttachments(
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

/**
 * 输入框占位符（随聊天模式变化：队列=入队，插话=并入/开新任务）。
 *
 * 抽成模块级函数是为了守住组件函数体的行数基线（check.mjs），纯文案、无状态。
 * @param busy 是否有回合在跑
 * @param mode 当前聊天模式（undefined 时按队列文案）
 * @returns 已本地化的占位符
 */
function placeholderOf(busy: boolean | undefined, mode: 'queue' | 'steer' | undefined): string {
  if (busy !== true) return t('发消息或创建任务，/ 调用技能，@ 文件或对话');
  return mode === 'steer'
    ? t('任务进行中：Enter 插话；无关内容会中断并转新任务')
    : t('任务进行中：Enter 加入队列，结束后依次发送');
}

/**
 * busy 态发送按钮的三件文案（图标 / 可访问名 / 悬浮说明），按聊天模式区分。
 * @param mode 当前聊天模式（undefined 时按队列）
 * @returns 按钮属性
 */
function busySendOf(mode: 'queue' | 'steer' | undefined): {
  glyph: string;
  label: string;
  title: string;
} {
  return mode === 'steer'
    ? { glyph: '↪', label: t('插话'), title: t('插话（Enter 发送，下一步生效）') }
    : {
        glyph: '＋',
        label: t('加入队列'),
        title: t('加入队列（Enter 发送，当前任务结束后依次发出）'),
      };
}

/**
 * 输入区组件。
 * @param props 组件属性。
 * @returns 输入区节点。
 */
export function Composer(props: ComposerProps): ReactElement {
  const {
    model,
    modelOptions,
    providerLabel,
    reasoning,
    reasoningOptions,
    permission,
    threadId,
    queue,
    seed,
    onToast,
    onApplyMode,
    onOpenTab,
    onOpenFile,
    onLoadThread,
    onModelChange,
    onReasoningChange,
    onPermissionChange,
    onSend,
    onStop,
    api,
    disabled,
    busy,
    activeTool,
  } = props;
  const [attachments, setAttachments] = React.useState<AttachmentDraft[]>([]);
  const [filePickerOpen, setFilePickerOpen] = React.useState<boolean>(false);
  const [pickerErr, setPickerErr] = React.useState<string | null>(null);
  const [mention, setMention] = React.useState<MentionState | null>(null);
  /** 文件路径缓存（@mention 数据源，首次触发时拉取一次）。 */
  const [fileCache, setFileCache] = React.useState<string[] | null>(null);
  const [slash, setSlash] = React.useState<SlashState | null>(null);
  /** 收起 @ / `/` 两类补全（发送与插话共用同一收尾）。 */
  const clearComposerSuggest = (): void => {
    setMention(null);
    setSlash(null);
  };
  /** 技能清单缓存（首次 `/` 时拉取一次）。 */
  const [skillCache, setSkillCache] = React.useState<SkillOption[] | null>(null);
  const [listening, setListening] = React.useState<boolean>(false);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const recogRef = React.useRef<SpeechRecognitionLike | null>(null);

  // 卸载时停掉可能仍在录的识别器，避免麦克风常亮（原 componentWillUnmount）。
  React.useEffect(() => {
    return () => {
      recogRef.current?.stop();
    };
  }, []);

  // F4「编辑重发」：外部把末条用户消息填回输入框（seed.nonce 变化即触发一次回填）。
  React.useEffect(() => {
    if (seed === undefined || seed === null) return;
    ComposerDraft.fill(taRef.current, seed.text);
    growComposerTextarea(taRef.current);
    setMention(null);
    setSlash(null);
  }, [seed]);

  /**
   * 从光标位置解析 @ 前缀 token，有则拉起 / 更新补全列表。
   * @returns 无
   */
  const refreshMention = (): void => {
    growComposerTextarea(taRef.current);
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? 0;
    const token = MentionResolver.parse(ta.value.slice(0, pos), pos);
    if (!token) {
      if (mention !== null) setMention(null);
      return;
    }
    const apply = (paths: readonly string[]): void => {
      const items = MentionResolver.filter(paths, token.query);
      setMention(items.length > 0 ? { start: token.start, items, idx: 0 } : null);
    };
    if (fileCache !== null) {
      apply(fileCache);
      return;
    }
    api
      .listFs(4)
      .then((r) => {
        const paths = FileTreeFlattener.collect(r.tree ?? []);
        setFileCache(paths);
        apply(paths);
      })
      .catch(() => setMention(null));
  };

  /**
   * 选中补全项：把 @token 替换为 `@path `。
   * @param item 选中路径
   * @returns 无
   */
  const applyMention = (item: string): void => {
    const ta = taRef.current;
    if (!ta || !mention) return;
    const pos = ta.selectionStart ?? 0;
    const v = ta.value;
    ta.value = v.slice(0, mention.start) + '@' + item + ' ' + v.slice(pos);
    growComposerTextarea(taRef.current);
    setMention(null);
    ta.focus();
  };

  /**
   * 解析 `/` 技能前缀；命中时拉取/过滤技能并返回 true。
   * @returns 是否由 `/` 接管本次补全
   */
  const refreshSlash = (): boolean => {
    const ta = taRef.current;
    if (!ta) return false;
    const pos = ta.selectionStart ?? 0;
    const token = SlashResolver.parse(ta.value, pos);
    if (token === null) {
      if (slash !== null) setSlash(null);
      return false;
    }
    if (mention !== null) setMention(null);
    const apply = (skills: readonly SkillOption[]): void => {
      const items = SlashResolver.filter(skills, token.query);
      setSlash(items.length > 0 ? { token, items, idx: 0 } : null);
    };
    if (skillCache !== null) {
      apply(skillCache);
      return true;
    }
    api
      .listSkills()
      .then((r) => {
        const skills = r.skills ?? [];
        setSkillCache(skills);
        apply(skills);
      })
      .catch(() => setSlash(null));
    return true;
  };

  /** 输入/点击时统一刷新 `@` 与 `/` 补全（`/` 优先）。 @returns 无 */
  const refreshCompletions = (): void => {
    growComposerTextarea(taRef.current);
    if (!refreshSlash()) refreshMention();
  };

  /**
   * 选中技能：把 `/query` 替换为 `/name `。
   * @param item 选中技能
   * @returns 无
   */
  const applySlash = (item: SkillOption): void => {
    const ta = taRef.current;
    if (!ta || slash === null) return;
    const pos = ta.selectionStart ?? 0;
    const next = SlashResolver.apply(ta.value, slash.token, item.name, pos);
    ta.value = next.text;
    ta.selectionStart = next.caret;
    ta.selectionEnd = next.caret;
    growComposerTextarea(ta);
    setSlash(null);
    ta.focus();
  };

  /** 开始 / 停止语音输入。 @returns 无 */
  const toggleVoice = (): void => {
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    const recog = SpeechRecognitionFactory.create('zh-CN');
    if (recog === null) return;
    recog.onresult = (e) => {
      const ta = taRef.current;
      if (!ta) return;
      const add = SpeechTranscript.concat(e);
      if (add !== '') {
        ta.value = ta.value === '' ? add : ta.value.replace(/\s*$/, '') + ' ' + add;
        growComposerTextarea(taRef.current);
      }
    };
    recog.onend = () => setListening(false);
    recog.onerror = () => setListening(false);
    recogRef.current = recog;
    setListening(true);
    try {
      recog.start();
    } catch {
      setListening(false);
    }
  };

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
      const drafts = (r.files as RemoteFile[]).map((f, i) => AttachmentDraftFactory.fromRemote(f, base + '_' + i));
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

  /**
   * 粘贴：从中取文件附件。
   * @param e 剪贴板事件
   * @returns 无
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  /**
   * 拖拽落点：取文件附件。
   *
   * 桌面桥能给出拖入文件的**真实路径**时（preload `webUtils.getPathForFile`），优先走
   * 服务端 `attach.read`（与 FilePicker 同通道，大文件不必整个 base64 过渲染层）；
   * 浏览器 / 虚拟文件才回落浏览器读（决策见 `AttachmentDrop`）。
   * @param e 拖拽事件
   * @returns 无
   */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      const paths = pathsForDrop(Array.from(dt.files), desktopBridge()?.pathForFile);
      if (paths !== null) {
        void addRemoteFiles([...paths]);
        return;
      }
      void addFiles(dt.files);
    }
  };

  /**
   * 移除单个附件。
   * @param id 附件 id
   * @returns 无
   */
  const removeAt = (id: string): void => setAttachments((prev) => prev.filter((a) => a.id !== id));

  /** 发送：把附件按图片 / 文件拆分后上抛，并清空输入与草稿。 @returns 无 */
  const handleSend = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    const prompt = ta.value.trim();
    if (prompt === '' && attachments.length === 0) return;
    // 发送路由在 ComposerController：空闲=直接开跑；在飞=按聊天模式排队或插话
    // （2026-10-31 起两种模式都由控制器统一分流，输入区不再自己判断）。
    const images: { data?: string; mediaType?: string }[] = [];
    const files: FileAttachment[] = [];
    splitComposerAttachments(attachments, images, files);
    ta.value = '';
    growComposerTextarea(taRef.current);
    setAttachments([]);
    clearComposerSuggest();
    onSend(prompt, images, files);
  };

  /**
   * 键盘：补全打开时接管方向键 / Enter / Tab / Esc，避免误发送；否则 Enter 发送。
   * @param e 键盘事件
   * @returns 无
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (slash !== null && slash.items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSlash({
          ...slash,
          idx: MentionResolver.move(slash.idx, slash.items.length, e.key === 'ArrowDown' ? 1 : -1),
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySlash(slash.items[slash.idx] ?? slash.items[0]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlash(null);
        return;
      }
    }
    if (mention !== null && mention.items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({
          ...mention,
          idx: MentionResolver.move(mention.idx, mention.items.length, e.key === 'ArrowDown' ? 1 : -1),
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(mention.items[mention.idx] ?? '');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        setSlash(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** busy 态发送按钮的文案（按聊天模式：入队 / 插话）。 */
  const busySend = busySendOf(queue?.mode);

  return (
    <div
      className="composer"
      role="region"
      aria-label={t('任务输入区')}
      onDragOver={(e: React.DragEvent) => e.preventDefault()}
      onDrop={onDrop}
    >
      {busy === true ? <WorkIndicator activeTool={activeTool ?? null} /> : null}
      {/* 输入卡片：正文在上、控制行在下（截图式 Composer 的版式）。 */}
      <div className="composer-box">
        <div className="composer-input">
          {renderSlashView(slash, applySlash)}
          {renderMentionView(mention, applyMention)}
          <textarea
            id="prompt"
            rows={1}
            ref={taRef}
            aria-label={t('任务输入框：输入任务，Enter 发送，Shift+Enter 换行，@ 引用文件，/ 选择技能')}
            placeholder={placeholderOf(busy, queue?.mode)}
            onPaste={onPaste}
            onInput={refreshCompletions}
            onClick={refreshCompletions}
            onKeyDown={onKeyDown}
          ></textarea>
        </div>

        {renderAttachmentsView(attachments, removeAt)}

        <div className="composer-bar">
          <div className="composer-bar-left">
            <AddMenu
              threadId={threadId ?? ''}
              api={api}
              onAttach={() => {
                setPickerErr(null);
                setFilePickerOpen(true);
              }}
              onToast={(m, k) => onToast?.(m, k)}
              onApplyMode={onApplyMode}
              onOpenTab={(key) => onOpenTab?.(key)}
              onOpenFile={(p) => onOpenFile?.(p)}
              onLoadThread={(id) => onLoadThread?.(id)}
            />
            <PermissionPicker permission={permission} onPick={onPermissionChange} api={api} />
          </div>
          <div className="composer-bar-right">
            {/* 容量入口已于 2026-10-28 移入控制台「上下文」面板（用户：不要挤输入区）。
                这里只留"要动手"的控件：权限 / 模型 / 语音 / 发送。 */}
            {/* 模型与推理强度合并为一个入口（2026-10-17）：强度不再是输入行里并排的第二个下拉，
                而是弹窗内的进度条——两者本就是同一个决定的两半，且强度是有序量。
                原先这里有两个 Dropdown（"推理强度" + "模型"），是输入行最宽的两块 chrome。 */}
            <ModelPicker
              model={model}
              {...(modelOptions !== undefined ? { modelOptions } : {})}
              reasoning={reasoning}
              {...(reasoningOptions !== undefined ? { reasoningOptions } : {})}
              {...(providerLabel ? { providerLabel } : {})}
              onModelChange={onModelChange}
              onReasoningChange={onReasoningChange}
            />
            {SpeechRecognitionFactory.supported() ? (
              <button
                className={'iconbtn mic' + (listening ? ' listening' : '')}
                title={listening ? t('停止语音输入') : t('语音输入（中文）')}
                aria-label={listening ? t('停止语音输入') : t('开始语音输入')}
                onClick={toggleVoice}
              >
                {icon(listening ? 'x' : 'mic', { size: 15 })}
              </button>
            ) : null}
            {busy === true ? (
              <>
                <button
                  className="send round"
                  aria-label={busySend.label}
                  title={busySend.title}
                  onClick={handleSend}
                >
                  {busySend.glyph}
                </button>
                <button
                  className="stop round"
                  aria-label={t('停止生成')}
                  title={t('停止生成')}
                  onClick={() => {
                    onStop?.();
                  }}
                >
                  ■
                </button>
              </>
            ) : (
              <button
                className="send round"
                disabled={disabled}
                aria-label={t('发送任务')}
                title={t('发送（Enter）')}
                onClick={handleSend}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>

      {pickerErr ? (
        <div className="fp-err" style={PICKER_ERR_BOX}>
          {pickerErr}
        </div>
      ) : null}
      {filePickerOpen ? (
        <FilePicker
          api={api}
          onCancel={() => setFilePickerOpen(false)}
          onPick={(paths: string[]) => {
            setFilePickerOpen(false);
            void addRemoteFiles(paths);
          }}
        />
      ) : null}
    </div>
  );
}
