// 领域模型：对齐 web/index-classic.html（vanilla 版）中所有 JSON-RPC 方法的入参与返回形状。
// 组件层与服务层共享这些类型，确保重构后的 UI 与后端协议逐字段一致。

export type EventType =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'plan'
  | 'question'
  | 'todo'
  | 'turn_diff'
  | 'model'
  | 'session_meta';

export interface ThreadEvent {
  id: string;
  type: EventType;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

export interface TurnRunResult {
  threadId: string;
  /** 回合最终总结文本（后端最后一步非 text 时可能无对应 assistant 事件，UI 兜底渲染用）。 */
  finalText?: string;
  /** 本回合实际执行的步数。 */
  steps?: number;
  [key: string]: unknown;
}

export interface ThreadGetResult {
  items: ThreadEvent[];
}

export interface Config {
  modelAdapter?: string;
  model?: string;
  /** 推理强度（#B6）：minimal / low / medium / high / xhigh。 */
  reasoning?: string;
  approval?: string;
  sandbox?: string;
  escalation?: string;
  autoApprove?: boolean;
  workspace?: string;
  [key: string]: unknown;
}

/** 厂商预设（服务端 model.catalog 下发，与后端单一来源同步）。 */
export interface ProviderPreset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
  models: string[];
  /**
   * 该厂商合法的 reasoning_effort 档位（#B6 扩展，2026-09-08）：
   * - undefined 或 []：UI 退回内置兜底列表（向后兼容）
   * - 非空：Composer「推理强度」下拉按此清单渲染
   * 后端单一来源：src/server/providerPresets.ts 的 PROVIDER_PRESETS。
   */
  reasoningEffort?: string[];
}

/** 单厂商探测结果（凭据已打码，仅状态）。 */
export interface ProviderProbeResult {
  id: string;
  label: string;
  configured: boolean;
  ok: boolean;
  models: string[];
  source: 'models-endpoint' | 'chat-probe' | 'preset' | 'none';
  error?: string;
}

/** 通用文件附件（多模态输入，#B5）：图片/视频/任意文件随用户消息送入。 */
export interface FileAttachment {
  /** 原始文件名。 */
  name: string;
  /** MIME 类型，如 'image/png' / 'video/mp4' / 'application/pdf'。 */
  mediaType: string;
  /** base64 编码（不含 data: 前缀），需配合 mediaType。 */
  data?: string;
  /** http(s) / data URI（与 data 二选一）。 */
  url?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: string[];
  source?: string;
  loaded?: boolean;
}

export interface PluginSearchEntry {
  manifest: PluginManifest;
  source: string;
}

export interface PluginReloadResult {
  ok?: boolean;
  loaded?: string[];
}

export interface MemoryFact {
  id: string;
  text: string;
  topic?: string;
  importance?: number;
  source?: string;
  createdAt?: string;
}

export interface MemoryListResult {
  count: number;
  facts: MemoryFact[];
}

export interface MemorySearchResult {
  count: number;
  results: MemoryFact[];
}

export interface Profile {
  id: string;
  name: string;
  description?: string;
  plugins?: string[];
}

export interface ActivePlugins {
  plugins?: string[];
}

export interface ProfileApplyResult {
  name?: string;
  id?: string;
  loaded?: string[];
  unloaded?: string[];
}

export interface BundlePackResult {
  path: string;
}

export interface BundleUnpackResult {
  installed?: string[];
  patchFile?: string;
}

export interface GraphStep {
  id: string;
  prompt: string;
  dependsOn?: string[];
}

export interface GraphDef {
  name: string;
  steps: GraphStep[];
  maxConcurrency?: number;
}

export interface GraphSummary {
  id: string;
  name: string;
  stepCount: number;
}

export interface GraphGetResult extends GraphDef {
  id: string;
}

export interface GraphRunResult {
  runId: string;
}

export type GraphNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface GraphNode {
  id: string;
  status: GraphNodeStatus;
  error?: string;
  steps?: unknown;
  durationMs?: number;
}

export interface GraphProgress {
  runId: string;
  id: string;
  status: GraphNodeStatus;
  error?: string;
  steps?: unknown;
  durationMs?: number;
}

export interface GraphDone {
  runId: string;
  ok: boolean;
  blackboard?: Record<string, unknown>;
  error?: string;
}

export interface GraphStatusResult {
  runId: string;
  defName: string;
  done: boolean;
  ok?: boolean;
  nodes: GraphNode[];
  blackboard?: Record<string, unknown>;
  error?: string;
}

export interface GraphRunState {
  runId: string;
  defName: string;
  done: boolean;
  ok?: boolean;
  nodes: GraphNode[];
  blackboard?: Record<string, unknown>;
  error?: string;
}

export interface FsNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FsNode[];
}

export interface FsReadResult {
  path: string;
  content?: string;
  isBinary?: boolean;
  truncated?: boolean;
  size?: number;
}

export interface Metrics {
  sessions?: number;
  eventsByType?: Record<string, number>;
}

export interface ApprovalRequest {
  requestId: string;
  toolName?: string;
  target?: string;
  args?: unknown;
}

export interface SseEnvelope {
  method: string;
  params: unknown;
}
