// 底部输入区（Codex 风格）：多模态粘贴/拖拽/选择（图片·视频·文件）+ 模型切换 + 推理强度切换
// + AI 权限等级切换。附件随消息经 turns.run 的 images / files 字段送入后端，开关经 config.update 持久化。

import { html, React } from '../deps.js';
import type { FileAttachment } from '../../types/models.js';
import { Dropdown } from './Dropdown.js';
import { FilePicker } from './FilePicker.js';
import type { ApiClient } from '../../core/ApiClient.js';

/** 本地草稿附件（含预览 URL，仅前端使用）。 */
interface AttachmentDraft extends FileAttachment {
  id: string;
  kind: 'image' | 'video' | 'file';
  previewUrl?: string;
  size?: number;
}

/** 兜底模型候选：服务端 model.catalog 下发当前厂商清单时不再使用；仅作离线回退。 */
const KNOWN_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
  'o3-mini',
  'o4-mini',
  'gpt-4.1',
  'claude-3.5-sonnet',
  'claude-3.7-sonnet',
  'deepseek-chat',
  'deepseek-reasoner',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
];

/** 推理强度兜底档位（向后兼容：当 model.catalog 未下发 reasoningEffort 时使用）。
 *  实际厂商合法值由后端 PROVIDER_PRESETS 单点维护，下发后这里被覆盖（#B6 扩展，2026-09-08）。 */
const REASONING_LEVELS: { value: string; label: string }[] = [
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '弱' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '强' },
  { value: 'xhigh', label: '极强' },
];

/** 推理档位中文标签映射（档位值 → UI 短标签）。
 *  对服务端下发的未知档位（如 deepseek 的 'none' / 'max'）也能给出合理标签。 */
const REASONING_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  none: '无',
  minimal: '极简',
  low: '弱',
  medium: '中',
  high: '强',
  xhigh: '极强',
  max: '极致',
};

/** AI 权限等级（映射后端 approval 枚举：审批=ask 每次确认 / 默认=rules 按规则 / 完全访问=auto 全放行）。 */
const PERMISSION_LEVELS: { value: string; label: string; hint: string }[] = [
  { value: 'ask', label: '审批', hint: '每次工具调用都需确认' },
  { value: 'rules', label: '默认', hint: '按规则自动放行安全工具' },
  { value: 'auto', label: '完全访问', hint: '工具全部自动放行' },
];

export interface ComposerProps {
  model: string;
  /** 当前厂商可用模型清单（服务端 model.catalog 下发；缺省用 KNOWN_MODELS 兜底）。 */
  modelOptions?: string[];
  /** 当前厂商展示名（下拉标题显示「模型 · DeepSeek」）。 */
  providerLabel?: string;
  reasoning: string;
  /**
   * 当前厂商合法的 reasoning_effort 档位（#B6 扩展，2026-09-08）：
   * - undefined：未拿到 catalog，用内置 5 档兜底
   * - []：该厂商无档位（dashscope / anthropic / ollama），下拉只显示「推理强度」占位
   * - 非空：按此清单渲染下拉（DeepSeek 7 档 / OpenAI 5 档等）
   * 档位 label 优先用 REASONING_LABEL_OVERRIDES 映射中文；未知档位降级显示原值。
   */
  reasoningOptions?: string[];
  permission: string;
  onModelChange: (v: string) => void;
  onReasoningChange: (v: string) => void;
  onPermissionChange: (v: string) => void;
  onSend: (
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ) => void;
  /** ApiClient（附件 FilePicker 走 attach.read 读 base64 用）。 */
  api: ApiClient;
  disabled?: boolean;
  /** 回合进行中（agent 正在干活）——显示工作状态条。 */
  busy?: boolean;
  /** 当前正在调用的工具名（无则显示"思考中"）。 */
  activeTool?: string | null;
}

function readFileAsDraft(file: File, id: string): Promise<AttachmentDraft> {
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
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
      resolve({
        id,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        data,
        kind,
        previewUrl: dataUrl,
        size: file.size,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function fileIcon(mediaType: string): string {
  if (mediaType.startsWith('video/')) return '🎬';
  if (mediaType.startsWith('audio/')) return '🎵';
  if (mediaType.startsWith('image/')) return '🖼';
  if (mediaType.includes('pdf')) return '📕';
  if (mediaType.includes('zip') || mediaType.includes('tar')) return '🗜';
  if (mediaType.includes('json') || mediaType.includes('javascript') || mediaType.includes('typescript')) return '📜';
  return '📎';
}

function humanSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 工作状态条：回合进行中显示动画 + 当前动作 + 已耗时，让"看不见的等待"变成"看得见的干活"。 */
function WorkIndicator(props: { activeTool: string | null }): ReactElement {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const action = props.activeTool != null ? '正在调用 ' + props.activeTool : '思考中';
  return html`<div className="work-indicator">
    <span className="wi-dot"></span>
    <span className="wi-text">${action}</span>
    <span className="wi-time">${elapsed >= 1 ? elapsed + 's' : '刚刚'}</span>
  </div>`;
}

export function Composer(props: ComposerProps): ReactElement {
  const { model, modelOptions: optionsProp, providerLabel, reasoning, reasoningOptions, permission, onModelChange, onReasoningChange, onPermissionChange, onSend, disabled, busy, activeTool, api } = props;
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentDraft[]>([]);
  const [filePickerOpen, setFilePickerOpen] = React.useState(false);
  const [pickerErr, setPickerErr] = React.useState<string | null>(null);

  const addFiles = React.useCallback(async (list: FileList | File[]) => {
    const drafts = await Promise.all(
      Array.from(list).map((f, i) => readFileAsDraft(f, 'att' + Date.now() + '_' + i)),
    );
    setAttachments((prev) => [...prev, ...drafts]);
  }, []);

  /** FilePicker 选完文件：批量调 attach.read 转 AttachmentDraft（不再走浏览器 FileReader）。 */
  const addRemoteFiles = React.useCallback(
    async (paths: string[]) => {
      setPickerErr(null);
      try {
        const r = await api.attachRead(paths);
        if (r.files.length === 0 && r.errors.length > 0) {
          setPickerErr(r.errors[0].error);
          return;
        }
        const drafts: AttachmentDraft[] = r.files.map((f, i) => {
          const dataUrl = `data:${f.mediaType};base64,${f.data}`;
          // AttachmentDraft.kind 仅支持 image/video/file，audio 走 file 兜底（前端无预览控件）。
          const kind: AttachmentDraft['kind'] = f.kind === 'image' || f.kind === 'video' ? f.kind : 'file';
          return {
            id: 'att' + Date.now() + '_' + i,
            name: f.name,
            mediaType: f.mediaType,
            data: f.data,
            kind,
            previewUrl: kind === 'image' || kind === 'video' ? dataUrl : undefined,
            size: f.size,
          };
        });
        setAttachments((prev) => [...prev, ...drafts]);
        if (r.errors.length > 0) {
          setPickerErr(
            r.errors.length + ' 个文件读取失败：' + r.errors.map((e) => e.error).join('；'),
          );
        }
      } catch (e) {
        setPickerErr('附件读取失败：' + (e as Error).message);
      }
    },
    [api],
  );

  const onPaste = React.useCallback(
    (e: ClipboardEvent) => {
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
    },
    [addFiles],
  );

  const onDrop = React.useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        void addFiles(dt.files);
      }
    },
    [addFiles],
  );

  const removeAt = React.useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleSend = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const prompt = ta.value.trim();
    if (!prompt && attachments.length === 0) return;
    const images: { data?: string; mediaType?: string }[] = [];
    const files: FileAttachment[] = [];
    for (const a of attachments) {
      const base = { name: a.name, mediaType: a.mediaType, data: a.data };
      if (a.kind === 'image') images.push(base);
      else files.push(base);
    }
    ta.value = '';
    setAttachments([]);
    onSend(prompt, images, files);
  }, [attachments, onSend]);

  // 模型下拉只显示当前厂商可用的模型（服务端下发；兜底内置清单）+ 当前值，不再全厂商堆一起。
  const modelOptions = Array.from(
    new Set([model, ...(optionsProp && optionsProp.length > 0 ? optionsProp : KNOWN_MODELS)].filter(Boolean)),
  );
  const perm = PERMISSION_LEVELS.find((p) => p.value === permission);

  // 推理强度下拉（#B6 扩展，2026-09-08）：
  // - 优先用 server 下发的 reasoningOptions（厂商合法集）
  // - 未下发则用内置 5 档兜底
  // - 下发的为空数组时，dropdown 只显示「推理强度」占位（无任何档位可挑）
  // - 当前 reasoning 值若不在列表里也保留在选项中（兜底防误改）
  const effectiveReasoningOptions: { value: string; label: string }[] = React.useMemo(() => {
    const pool: string[] =
      reasoningOptions !== undefined
        ? reasoningOptions
        : REASONING_LEVELS.map((r) => r.value);
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const v of pool) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push({ value: v, label: REASONING_LABEL_OVERRIDES[v] ?? v });
    }
    // 当前 reasoning 不在列表里时补回去（防止用户已选值被换厂商后丢失）
    if (reasoning && !seen.has(reasoning)) {
      out.unshift({ value: reasoning, label: REASONING_LABEL_OVERRIDES[reasoning] ?? reasoning });
    }
    return out;
  }, [reasoningOptions, reasoning]);

  return html`<div className="composer" onDragOver=${(e: DragEvent) => e.preventDefault()} onDrop=${onDrop}>
    ${busy === true ? html`<${WorkIndicator} activeTool=${activeTool ?? null} />` : null}
    <div className="composer-bar">
      <${Dropdown}
        title=${providerLabel ? `模型 · ${providerLabel}` : '模型'}
        icon="🧠"
        value=${model}
        options=${modelOptions.map((m) => ({ value: m, label: m }))}
        onChange=${onModelChange}
      />
      <${Dropdown}
        title="推理强度"
        icon="🔥"
        value=${reasoning}
        options=${[{ value: '', label: '推理强度' }, ...effectiveReasoningOptions]}
        onChange=${onReasoningChange}
      />
      <${Dropdown}
        title="AI 权限等级"
        icon="🛡"
        value=${permission}
        options=${PERMISSION_LEVELS.map((p) => ({ value: p.value, label: p.label }))}
        onChange=${onPermissionChange}
      />
      ${perm ? html`<span className="ctl-hint">${perm.hint}</span>` : null}
      <button
        className="iconbtn attach"
        title="粘贴 / 拖拽 / 选择文件（项目内文件夹选择器风格）"
        onClick=${() => {
          setPickerErr(null);
          setFilePickerOpen(true);
        }}
      >📎</button>
      <input
        ref=${fileRef}
        type="file"
        multiple
        hidden
        onChange=${(e: Event) => {
          const inp = e.target as HTMLInputElement;
          if (inp.files && inp.files.length > 0) void addFiles(inp.files);
          inp.value = '';
        }}
      />
    </div>

    ${attachments.length > 0
      ? html`<div className="attachments">
          ${attachments.map(
            (a) => html`<div className=${'att att-' + a.kind} key=${a.id}>
              ${a.kind === 'image' && a.previewUrl
                ? html`<img className="att-thumb" src=${a.previewUrl} alt=${a.name} />`
                : null}
              ${a.kind === 'video' && a.previewUrl
                ? html`<video className="att-thumb" src=${a.previewUrl} controls preload="metadata" />`
                : null}
              ${a.kind === 'file'
                ? html`<div className="att-file">
                    <span className="att-ico">${fileIcon(a.mediaType)}</span>
                    <span className="att-name">${a.name}</span>
                  </div>`
                : null}
              <button className="att-x" title="移除" onClick=${() => removeAt(a.id)}>×</button>
              <span className="att-size">${humanSize(a.size)}</span>
            </div>`,
          )}
        </div>`
      : null}

    <div className="composer-input">
      <textarea
        id="prompt"
        rows="2"
        ref=${taRef}
        placeholder="输入任务，Enter 发送（Shift+Enter 换行）…  可粘贴 / 拖拽 / 点击 📎 附加图片·视频·文件"
        onPaste=${onPaste}
        onKeyDown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      ></textarea>
      <button className="send" disabled=${disabled} onClick=${handleSend}>发送</button>
    </div>

    ${pickerErr ? html`<div className="fp-err" style=${{ margin: '6px 14px 0' }}>${pickerErr}</div>` : null}
    ${filePickerOpen
      ? html`<${FilePicker}
          api=${api}
          onCancel=${() => setFilePickerOpen(false)}
          onPick=${(paths: string[]) => {
            setFilePickerOpen(false);
            void addRemoteFiles(paths);
          }}
        />`
      : null}
  </div>`;
}
