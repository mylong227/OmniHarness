// 底部输入区（Codex 风格）：多模态粘贴/拖拽/选择（图片·视频·文件）+ 模型切换 + 推理强度切换
// + AI 权限等级切换 + @mention 文件引用 + 语音输入。
// 附件随消息经 turns.run 的 images / files 字段送入后端，开关经 config.update 持久化。
//
// 面向对象改造：
// - 下拉选项构建 → ComposerOptions；@mention 解析 → MentionResolver；
//   文件树扁平化 → FileTreeFlattener；语音识别 → SpeechRecognitionFactory / SpeechTranscript；
//   附件草稿 → AttachmentDraftFactory / AttachmentIcon；工作条 → WorkIndicator 类组件。
// - 组件自身只保留交互状态（附件 / 选择器 / 补全 / 录音）与 DOM 引用。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import { Dropdown } from './Dropdown.js';
import { FilePicker } from './FilePicker.js';
import { WorkIndicator } from './WorkIndicator.js';
import { AddMenu } from './AddMenu.js';
import { PermissionPicker } from './PermissionPicker.js';
import { ContextCapacityPanel } from './ContextCapacityPanel.js';
import { MentionResolver } from '../models/MentionResolver.js';
import { ComposerOptions } from '../models/ComposerOptions.js';
import { FileTreeFlattener } from '../models/FileTreeFlattener.js';
import { FileSizeFormatter } from '../models/FileSizeFormatter.js';
import {
  SpeechRecognitionFactory,
  SpeechTranscript,
  type SpeechRecognitionLike,
} from '../models/SpeechRecognitionFactory.js';
import {
  AttachmentDraftFactory,
  AttachmentIcon,
  type AttachmentDraft,
  type RemoteFile,
} from '../models/AttachmentIcon.js';
import type { FileAttachment } from '../../types/models.js';
import type { ApiClient } from '../../core/ApiClient.js';

const PICKER_ERR_BOX: Record<string, string> = { margin: '6px 14px 0' };

export interface ComposerProps {
  model: string;
  /** 当前厂商可用模型清单（服务端 model.catalog 下发；缺省用内置兜底）。 */
  modelOptions?: string[];
  /** 当前厂商展示名（下拉标题显示「模型 · DeepSeek」）。 */
  providerLabel?: string;
  reasoning: string;
  /** 当前厂商合法的 reasoning_effort 档位（见 ComposerOptions.reasoning 的三态语义）。 */
  reasoningOptions?: string[];
  permission: string;
  /** 当前会话 id（目标 / 计划 / 绘图模式按会话持久化；上下文容量报告维度）。 */
  threadId?: string | null;
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
  /** 停止在跑回合（busy 时由停止按钮触发，对标 codex 的 stop）。 */
  onStop?: () => void;
  /** ApiClient（附件 FilePicker 走 attach.read 读 base64 用）。 */
  api: ApiClient;
  disabled?: boolean;
  /** 回合进行中（agent 正在干活）——显示工作状态条。 */
  busy?: boolean;
  /** 当前正在调用的工具名（无则显示"思考中"）。 */
  activeTool?: string | null;
}

interface MentionState {
  /** `@` 在输入框全文中的下标。 */
  start: number;
  items: string[];
  idx: number;
}

interface ComposerState {
  attachments: AttachmentDraft[];
  filePickerOpen: boolean;
  pickerErr: string | null;
  mention: MentionState | null;
  /** 文件路径缓存（@mention 数据源，首次触发时拉取一次）。 */
  fileCache: string[] | null;
  listening: boolean;
}

/** 底部输入区组件。 */
export class Composer extends AppComponent<ComposerProps, ComposerState> {
  private taRef: HTMLTextAreaElement | null = null;
  private recog: SpeechRecognitionLike | null = null;

  constructor(props: ComposerProps) {
    super(props);
    this.state = {
      attachments: [],
      filePickerOpen: false,
      pickerErr: null,
      mention: null,
      fileCache: null,
      listening: false,
    };
  }

  override componentWillUnmount(): void {
    // 卸载时停掉可能仍在录的识别器，避免麦克风常亮。
    this.recog?.stop();
  }

  // ---------------- @mention ----------------

  /** 从光标位置解析 @ 前缀 token，有则拉起 / 更新补全列表。 */
  private readonly refreshMention = (): void => {
    const ta = this.taRef;
    if (!ta) return;
    const pos = ta.selectionStart ?? 0;
    const token = MentionResolver.parse(ta.value.slice(0, pos), pos);
    if (!token) {
      if (this.state.mention !== null) this.setState({ mention: null });
      return;
    }
    const apply = (paths: readonly string[]): void => {
      const items = MentionResolver.filter(paths, token.query);
      this.setState({ mention: items.length > 0 ? { start: token.start, items, idx: 0 } : null });
    };
    const cached = this.state.fileCache;
    if (cached !== null) {
      apply(cached);
      return;
    }
    this.props.api
      .listFs(4)
      .then((r) => {
        const paths = FileTreeFlattener.collect(r.tree ?? []);
        this.setState({ fileCache: paths });
        apply(paths);
      })
      .catch(() => this.setState({ mention: null }));
  };

  /** 选中补全项：把 @token 替换为 `@path `。 */
  private applyMention(item: string): void {
    const ta = this.taRef;
    const { mention } = this.state;
    if (!ta || !mention) return;
    const pos = ta.selectionStart ?? 0;
    const v = ta.value;
    ta.value = v.slice(0, mention.start) + '@' + item + ' ' + v.slice(pos);
    this.setState({ mention: null });
    ta.focus();
  }

  // ---------------- 语音输入 ----------------

  private readonly toggleVoice = (): void => {
    const { listening } = this.state;
    if (listening) {
      this.recog?.stop();
      return;
    }
    const recog = SpeechRecognitionFactory.create('zh-CN');
    if (recog === null) return;
    recog.onresult = (e) => {
      const ta = this.taRef;
      if (!ta) return;
      const add = SpeechTranscript.concat(e);
      if (add !== '') ta.value = ta.value === '' ? add : ta.value.replace(/\s*$/, '') + ' ' + add;
    };
    recog.onend = () => this.setState({ listening: false });
    recog.onerror = () => this.setState({ listening: false });
    this.recog = recog;
    this.setState({ listening: true });
    try {
      recog.start();
    } catch {
      this.setState({ listening: false });
    }
  };

  // ---------------- 附件 ----------------

  private async addFiles(list: FileList | File[]): Promise<void> {
    const base = 'att' + Date.now();
    const drafts = await Promise.all(
      Array.from(list).map((f, i) => AttachmentDraftFactory.fromFile(f, base + '_' + i)),
    );
    this.setState((prev) => ({ attachments: [...prev.attachments, ...drafts] }));
  }

  /** FilePicker 选完文件：批量调 attach.read 转草稿（不走浏览器 FileReader）。 */
  private async addRemoteFiles(paths: string[]): Promise<void> {
    this.setState({ pickerErr: null });
    try {
      const r = await this.props.api.attachRead(paths);
      if (r.files.length === 0 && r.errors.length > 0) {
        this.setState({ pickerErr: r.errors[0]?.error ?? '附件读取失败' });
        return;
      }
      const base = 'att' + Date.now();
      const drafts = (r.files as RemoteFile[]).map((f, i) =>
        AttachmentDraftFactory.fromRemote(f, base + '_' + i),
      );
      this.setState((prev) => ({ attachments: [...prev.attachments, ...drafts] }));
      if (r.errors.length > 0) {
        this.setState({
          pickerErr: r.errors.length + ' 个文件读取失败：' + r.errors.map((e) => e.error).join('；'),
        });
      }
    } catch (e) {
      this.setState({ pickerErr: '附件读取失败：' + (e as Error).message });
    }
  }

  private readonly onPaste = (e: ClipboardEvent): void => {
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
      void this.addFiles(files);
    }
  };

  private readonly onDrop = (e: DragEvent): void => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) void this.addFiles(dt.files);
  };

  private readonly removeAt = (id: string): void => {
    this.setState((prev) => ({ attachments: prev.attachments.filter((a) => a.id !== id) }));
  };

  // ---------------- 发送 ----------------

  private readonly handleSend = (): void => {
    const ta = this.taRef;
    if (!ta) return;
    const { attachments } = this.state;
    const prompt = ta.value.trim();
    if (prompt === '' && attachments.length === 0) return;
    const images: { data?: string; mediaType?: string }[] = [];
    const files: FileAttachment[] = [];
    for (const a of attachments) {
      const base = { name: a.name, mediaType: a.mediaType, data: a.data };
      if (a.kind === 'image') images.push(base);
      else files.push(base);
    }
    ta.value = '';
    this.setState({ attachments: [], mention: null });
    this.props.onSend(prompt, images, files);
  };

  /** 键盘：补全打开时接管方向键 / Enter / Tab / Esc，避免误发送。 */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const { mention } = this.state;
    if (mention !== null && mention.items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.setState({
          mention: { ...mention, idx: MentionResolver.move(mention.idx, mention.items.length, e.key === 'ArrowDown' ? 1 : -1) },
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.applyMention(mention.items[mention.idx] ?? '');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setState({ mention: null });
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  };

  private renderAttachments(): ReactElement | null {
    const { attachments } = this.state;
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
                <span className="att-ico">{AttachmentIcon.of(a.mediaType)}</span>
                <span className="att-name">{a.name}</span>
              </div>
            ) : null}
            <button className="att-x" title="移除" onClick={() => this.removeAt(a.id)}>
              ×
            </button>
            <span className="att-size">
              {a.size === undefined ? '' : FileSizeFormatter.human(a.size)}
            </span>
          </div>
        ))}
      </div>
    );
  }

  private renderMention(): ReactElement | null {
    const { mention } = this.state;
    if (mention === null) return null;
    return (
      <div className="mention-pop" role="listbox" aria-label="文件引用补全">
        {mention.items.map((p, i) => (
          <div
            key={p}
            role="option"
            aria-selected={i === mention.idx}
            className={'mention-item' + (i === mention.idx ? ' active' : '')}
            title={'@' + p}
            onMouseDown={(e: MouseEvent) => {
              e.preventDefault();
              this.applyMention(p);
            }}
          >
            @{p}
          </div>
        ))}
      </div>
    );
  }

  override render(): ReactElement {
    const {
      model,
      modelOptions,
      providerLabel,
      reasoning,
      reasoningOptions,
      permission,
      onModelChange,
      onReasoningChange,
      onPermissionChange,
      disabled,
      busy,
      activeTool,
      api,
      threadId,
      onStop,
    } = this.props;
    const { filePickerOpen, pickerErr, listening } = this.state;
    const hint = ComposerOptions.permissionHint(permission);
    return (
      <div
        className="composer"
        role="region"
        aria-label="任务输入区"
        onDragOver={(e: DragEvent) => e.preventDefault()}
        onDrop={this.onDrop}
      >
        {busy === true ? <WorkIndicator activeTool={activeTool ?? null} /> : null}
        <div className="composer-bar">
          <Dropdown
            title={providerLabel ? `模型 · ${providerLabel}` : '模型'}
            icon="🧠"
            value={model}
            options={ComposerOptions.models(model, modelOptions).map((m) => ({
              value: m,
              label: m,
            }))}
            onChange={onModelChange}
          />
          <Dropdown
            title="推理强度"
            icon="🔥"
            value={reasoning}
            options={[
              { value: '', label: '推理强度' },
              ...ComposerOptions.reasoning(reasoning, reasoningOptions),
            ]}
            onChange={onReasoningChange}
          />
          <PermissionPicker permission={permission} onPick={onPermissionChange} api={api} />
          {hint ? <span className="ctl-hint">{hint}</span> : null}
          <ContextCapacityPanel
            threadId={threadId ?? ''}
            api={api}
            onToast={(m, k) => this.props.onToast?.(m, k)}
          />
          <AddMenu
            threadId={threadId ?? ''}
            api={api}
            onAttach={() => this.setState({ pickerErr: null, filePickerOpen: true })}
            onToast={(m, k) => this.props.onToast?.(m, k)}
            onOpenTab={(key) => this.props.onOpenTab?.(key)}
            onOpenFile={(p) => this.props.onOpenFile?.(p)}
            onLoadThread={(id) => this.props.onLoadThread?.(id)}
          />
          <button
            className="iconbtn attach"
            title="粘贴 / 拖拽 / 选择文件（项目内文件夹选择器风格）"
            aria-label="附加图片、视频或文件"
            onClick={() => this.setState({ pickerErr: null, filePickerOpen: true })}
          >
            📎
          </button>
          {SpeechRecognitionFactory.supported() ? (
            <button
              className={'iconbtn mic' + (listening ? ' listening' : '')}
              title={listening ? '停止语音输入' : '语音输入（中文）'}
              aria-label={listening ? '停止语音输入' : '开始语音输入'}
              onClick={this.toggleVoice}
            >
              {listening ? '⏹' : '🎙'}
            </button>
          ) : null}
        </div>

        {this.renderAttachments()}

        <div className="composer-input">
          {this.renderMention()}
          <textarea
            id="prompt"
            rows={2}
            ref={(el: HTMLTextAreaElement | null) => {
              this.taRef = el;
            }}
            aria-label="任务输入框：输入任务，Enter 发送，Shift+Enter 换行，@ 引用文件"
            placeholder="输入任务，Enter 发送（Shift+Enter 换行）…  可粘贴/拖拽/📎 附件，@ 引用文件，🎙 语音输入"
            onPaste={this.onPaste}
            onInput={this.refreshMention}
            onClick={this.refreshMention}
            onKeyDown={this.onKeyDown}
          ></textarea>
          {busy === true ? (
            <button
              className="stop"
              aria-label="停止生成"
              title="停止生成"
              onClick={() => {
                onStop?.();
              }}
            >
              ■ 停止
            </button>
          ) : (
            <button className="send" disabled={disabled} aria-label="发送任务" onClick={this.handleSend}>
              发送
            </button>
          )}
        </div>

        {pickerErr ? (
          <div className="fp-err" style={PICKER_ERR_BOX}>
            {pickerErr}
          </div>
        ) : null}
        {filePickerOpen ? (
          <FilePicker
            api={api}
            onCancel={() => this.setState({ filePickerOpen: false })}
            onPick={(paths: string[]) => {
              this.setState({ filePickerOpen: false });
              void this.addRemoteFiles(paths);
            }}
          />
        ) : null}
      </div>
    );
  }
}
