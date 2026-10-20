// 纯函数工具层（零 React / 零 DOM 依赖）：对话流与变更面板的文本/结构计算逻辑。
// 抽离出来便于在 node --test 下直接单测（web 此前 0 测试文件，审计 P0）。
// 注意：本文件不得 import 'react'（纯文本工具，保持零 React 依赖才能在任何环境直接加载）。

import type { ThreadEvent } from '../types/models.ts';
import { FileSizeFormatter } from './models/FileSizeFormatter.ts';
import { t } from './i18n/i18n.ts';

/**
 * 工具名的**中文动作标签**（2026-10-20：轨迹 / 步骤行不再露出接口名）。
 *
 * 只登记「还需要人话」的工具；read/write/patch/shell/search 等已有专门句式（带路径/命令），
 * 不在此表，避免与 `describeToolCall` 的既有措辞打架。
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  edit: '编辑',
  glob: '匹配文件',
  patch_candidates: '候选补丁',
  workflow_memory: '工作流记忆',
  shell_job: '管理后台作业',
  shell_interactive: '打开终端',
  run_code: '运行代码',
  a2a_delegate: '跨代理委派',
  browser_screenshot: '网页截图',
  rollback: '回滚',
  checkpoint: '创建检查点',
  remember: '写入记忆',
  recall: '读取记忆',
  memory_search: '检索记忆',
  todo_read: '读取待办',
  capability_metadata: '查看能力元数据',
  ask_user: '询问用户',
  tool_search: '查找工具',
  spill_read: '读取溢出',
  budget_status: '查看预算',
  view_image: '查看图片',
  view_media: '查看媒体',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  policy_eval: '评估策略',
  agent_identity: '查看身份',
  run_goal: '自主目标',
  run_workflow: '运行工作流',
  registry: '工具注册表',
  mcp: '调用 MCP',
  lsp_go_to_definition: '代码导航',
  lsp_find_references: '查找引用',
  lsp_hover: '查看提示',
  lsp_status: '语言服务状态',
  lsp_diagnostics: '代码诊断',
  lsp_document_symbols: '文档符号',
  lsp_code_action: '代码动作',
  lsp_workspace_symbols: '工作区符号',
};

/** 工具入参里「对象」字段的候选顺序（按业务语义，而不是按 JSON 键序）。 */
const TOOL_SUBJECT_KEYS: Readonly<Record<string, readonly string[]>> = {
  edit: ['path', 'file', 'target'],
  glob: ['pattern', 'query'],
  run_code: ['code'],
  memory_search: ['query'],
  web_search: ['query'],
  web_fetch: ['url', 'href'],
  view_image: ['path', 'file'],
  view_media: ['path', 'file'],
  browser_screenshot: ['url', 'path'],
  ask_user: ['question', 'prompt'],
  tool_search: ['query', 'q'],
  spill_read: ['id', 'callId'],
  remember: ['text', 'content', 'fact'],
  recall: ['query'],
  workflow_memory: ['query', 'task'],
  shell_job: ['command', 'action'],
  shell_interactive: ['command'],
  run_goal: ['goal', 'task', 'prompt'],
  run_workflow: ['name', 'workflow', 'task'],
  a2a_delegate: ['task', 'prompt'],
  patch_candidates: ['path'],
  checkpoint: ['label', 'name'],
  mcp: ['tool', 'name', 'server'],
  lsp_go_to_definition: ['path', 'file', 'uri'],
  lsp_find_references: ['path', 'file', 'uri'],
  lsp_hover: ['path', 'file', 'uri'],
  lsp_status: [],
  lsp_diagnostics: ['path', 'file', 'uri'],
  lsp_document_symbols: ['path', 'file', 'uri'],
  lsp_code_action: ['path', 'file', 'uri'],
  lsp_workspace_symbols: ['query'],
};

/** 截断长字符串到指定字符数（按 UTF-16 单元），超长末尾加省略号。 */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** 从工具参数里抽一行可读摘要（首个标量值），超长截断——详情点开才看全量。 */
export function argSummary(args: unknown): string {
  if (args === null || args === undefined || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
    if (parts.length >= 2) break;
  }
  const s = parts.join(' · ');
  return s.length > 56 ? s.slice(0, 56) + '…' : s;
}

/**
 * 工具调用 → 人话叙述（WorkBuddy 范式）：把工具名+参数翻译成一行中文动作。
 */
export function describeToolCall(name: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const short = (s: string, n = 72): string => truncate(s.replace(/\s+/g, ' ').trim(), n);
  const pathOf = (k = 'path'): string => {
    const p = str(k) || str('file') || str('target');
    return p ? short(p, 60) : '';
  };
  switch (name) {
    case 'write_file': {
      const p = pathOf();
      return p ? t('写入 {path}', { path: p }) : t('写入文件');
    }
    case 'apply_patch': {
      const p = pathOf();
      return p ? t('修改 {path}', { path: p }) : t('修改文件');
    }
    case 'read_file': {
      const p = pathOf();
      return p ? t('读取 {path}', { path: p }) : t('读取文件');
    }
    case 'list_dir': {
      const p = pathOf();
      return p ? t('浏览目录 {path}', { path: p }) : t('浏览目录');
    }
    case 'shell':
    case 'bash': {
      const cmd = str('command') || str('cmd');
      return cmd ? t('执行命令 {cmd}', { cmd: short(cmd) }) : t('执行命令');
    }
    case 'search':
    case 'grep': {
      const q = str('pattern') || str('query');
      return q ? t('搜索 {q}', { q: short(q, 48) }) : t('搜索代码');
    }
    case 'plan_read':
      return t('查看计划');
    case 'plan_write':
      return t('更新计划');
    case 'plan_present':
      return t('展示计划');
    case 'todo_write':
      return t('更新待办');
    case 'sketch_write': {
      const title = str('title') || str('name');
      return title ? t('生成草图 {title}', { title: short(title) }) : t('生成草图');
    }
    case 'delegate':
    case 'subagent': {
      const task = str('task') || str('prompt');
      return task ? t('委派子任务 {task}', { task: short(task, 48) }) : t('委派子任务');
    }
    default: {
      const label = TOOL_LABELS[name];
      if (label !== undefined) {
        const subject = toolSubject(name, args);
        return subject !== ''
          ? t('{label} · {subject}', { label: t(label), subject })
          : t(label);
      }
      const summary = argSummary(args);
      return summary ? t('调用工具（{summary}）', { summary }) : t('调用工具');
    }
  }
}

/**
 * 工具动作的**标签**（步骤列表左侧固定列）：回答「做了什么类型的事」，不是工具名。
 *
 * 与 `describeToolCall` 的分工：后者给一句完整人话（工作状态条 / 过程摘要用），
 * 本函数只给动词标签，供步骤行做成「标签 | 对象」两列（2026-10-20 用户口径：
 * 不显示使用了什么工具，像活动记录一样展示）。
 * @param name 工具名
 * @returns 中文标签（作为 t() 的键）
 */
export function toolVerb(name: string): string {
  switch (name) {
    case 'read_file':
      return '读取';
    case 'write_file':
      return '写入';
    case 'apply_patch':
      return '编辑';
    case 'shell':
    case 'bash':
      return '运行命令';
    case 'list_dir':
      return '浏览';
    case 'search':
    case 'grep':
      return '搜索';
    case 'delegate':
    case 'subagent':
      return '委派';
    case 'sketch_write':
      return '生成草图';
    case 'todo_write':
      return '更新待办';
    case 'plan_read':
      return '查看计划';
    case 'plan_write':
      return '更新计划';
    case 'plan_present':
      return '展示计划';
    default:
      return TOOL_LABELS[name] ?? '调用';
  }
}

/**
 * 工具动作的**对象**（步骤列表右侧内容）：路径 / 命令 / 查询 / 任务标题。
 * @param name 工具名
 * @param args 工具入参
 * @returns 单行对象文本；无可用对象时为空串
 */
export function toolSubject(name: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const short = (s: string, n = 96): string => truncate(s.replace(/\s+/g, ' ').trim(), n);
  const pathOf = (): string => short(str('path') || str('file') || str('target'), 88);
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'list_dir':
      return pathOf();
    case 'apply_patch': {
      const explicit = pathOf();
      if (explicit !== '') return explicit;
      const patch = str('patch');
      const m = /^\+\+\+ b\/(.+)$/m.exec(patch);
      return m && m[1] !== undefined ? short(m[1], 88) : '';
    }
    case 'shell':
    case 'bash':
      return short(str('command') || str('cmd'), 110);
    case 'search':
    case 'grep':
      return short(str('pattern') || str('query'), 72);
    case 'delegate':
    case 'subagent':
      return short(str('task') || str('prompt'), 80);
    case 'sketch_write':
      return short(str('title') || str('name'), 72);
    case 'todo_write':
    case 'plan_read':
    case 'plan_write':
    case 'plan_present':
      return '';
    default: {
      const generic = genericToolSubject(name, args);
      return generic !== '' ? generic : argSummary(args);
    }
  }
}

/**
 * 通用工具对象提取：按 {@link TOOL_SUBJECT_KEYS} 的语义顺序取第一个非空字符串。
 * @param name 工具名
 * @param args 工具入参
 * @returns 截断后的单行对象；无可用字段时为空串
 */
function genericToolSubject(name: string, args: unknown): string {
  const fields = TOOL_SUBJECT_KEYS[name];
  if (fields === undefined || fields.length === 0) return '';
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  for (const key of fields) {
    const v = a[key];
    if (typeof v === 'string' && v.trim() !== '') {
      return truncate(v.replace(/\s+/g, ' ').trim(), 96);
    }
  }
  return '';
}

/**
 * 工具动作的附加度量：写文件的体积 + 新增行（编辑另含删除行）。
 *
 * 只对本地能直接读到的入参计算（write_file 的 content、apply_patch 的 patch）；
 * read_file 等没有可靠体积来源的工具返回空串，不猜。
 * @param name 工具名
 * @param args 工具入参
 * @returns 如 `2.0 KB +34 −0`；无度量时为空串
 */
export function toolMeta(name: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const text = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  if (name === 'write_file') {
    const content = text('content');
    if (content === '') return '';
    const lines = content.split('\n').length;
    return `${FileSizeFormatter.human(utf8Bytes(content))} +${lines} −0`;
  }
  if (name === 'apply_patch') {
    const patch = text('patch');
    if (patch === '') return '';
    let added = 0;
    let deleted = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
    }
    return `${FileSizeFormatter.human(utf8Bytes(patch))} +${added} −${deleted}`;
  }
  return '';
}

/**
 * UTF-8 字节数（体积口径与磁盘一致）；运行环境没有 TextEncoder 时退回字符数。
 * @param s 文本
 * @returns 字节数
 */
function utf8Bytes(s: string): number {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
  return s.length;
}

/** 外部 URL 提取（用于助手消息里的可点击链接卡片）。 */
const URL_RE = /\bhttps?:\/\/[^\s<>")'\]]+/g;
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)]+$/, ''); // 去掉末尾标点
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
export function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/** 回合内过程事件类型：放进 process-cluster 折叠。 */
export const PROCESS_TYPES = new Set(['reasoning', 'tool_call', 'tool_result']);

/** 单个事件块（结果类直接展示）。 */
export interface SingleBlock {
  readonly kind: 'single';
  readonly event: ThreadEvent;
}
/** 回合内连续过程事件合并块（reasoning/tool_call/tool_result 默认折叠）。 */
export interface ProcessBlock {
  readonly kind: 'process';
  readonly events: readonly ThreadEvent[];
  /** 块首 key，React 列表 diff 用。 */
  readonly key: string;
}
/**
 * 回合结果汇总块：由 `turn_diff` 收口的整轮结果（生成 / 修改的文件清单）。
 *
 * `events` 是**本轮**的事件切片（上一轮 turn_diff 之后到本轮 turn_diff），
 * 结果卡据此把写类工具回执与 diff 合并去重（见 models/TurnSummary）。
 */
export interface TurnSummaryBlock {
  readonly kind: 'turn_summary';
  readonly key: string;
  readonly diffEvent: ThreadEvent;
  readonly events: readonly ThreadEvent[];
}
export type DisplayBlock = SingleBlock | ProcessBlock | TurnSummaryBlock;

/** 收集「已被调用卡内联结果」的工具调用 id 集合（tool_result 隐藏判据的单一来源）。 */
export function collectToolCallIds(events: readonly ThreadEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== 'tool_call') continue;
    const p = e.payload || {};
    ids.add((p.callId as string) || e.id);
  }
  return ids;
}

/**
 * 该事件是否会在对话流里渲染出可见内容（`renderEventNode` 返回 null 的判据，两侧必须同源）。
 *
 * ## 为什么块构建必须先过这道筛（2026-10-07 用户报「滚动出现大面积空白」的真机定位）
 *
 * `session_meta` / `model` / 已被调用卡内联的 `tool_result` 在渲染层返回 null——但旧版块构建
 * 仍把它们计进 keys 并包一层 `.sw-block`（真实高度 0）。虚拟窗口的高度索引拿不到 0 高实测
 * （测量循环跳过 0），只能按 88px 估算 ⇒ 索引与真实布局**系统性漂移**：一个 27 块的窗口里有
 * 十几个这种空块时，padBottom 把视口下半截顶成占位空白（真机实测视口覆盖率跌到 46%）。
 * 在块构建阶段剔除，keys 与真实 DOM 一一对应，高度索引不再有「永远测不到的块」。
 * @param ev 事件
 * @param toolCallIds 已被内联的工具调用 id 集合（`collectToolCallIds`）
 * @returns 会渲染出可见内容为 true
 */
export function isRenderedEvent(ev: ThreadEvent, toolCallIds: ReadonlySet<string>): boolean {
  if (ev.type === 'session_meta' || ev.type === 'model') return false;
  if (ev.type === 'tool_result') {
    const p = ev.payload || {};
    return !toolCallIds.has((p.callId as string) || '');
  }
  return true;
}

/** 产物类工具调用（会在卡片里带出 ArtifactCard 的那些，口径同 `ArtifactResolver` 的工具表）。 */
const ARTIFACT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'apply_patch', 'sketch_write']);

/**
 * 该事件是不是「产出物的调用」（写文件 / 打补丁 / 出草图）。
 * @param ev 事件
 * @returns 是产物类工具调用为 true
 */
export function isArtifactCall(ev: ThreadEvent): boolean {
  if (ev.type !== 'tool_call') return false;
  const name = ev.payload?.name;
  return typeof name === 'string' && ARTIFACT_TOOLS.has(name);
}

/**
 * 取工具调用的稳定 id（payload.callId 优先，缺省回落事件 id）。
 * @param ev 工具调用事件
 * @returns 调用 id
 */
function callIdOf(ev: ThreadEvent): string {
  const p = ev.payload || {};
  return typeof p.callId === 'string' && p.callId !== '' ? p.callId : ev.id;
}

/**
 * 被回合结果卡收编的产物调用 id 集合。
 *
 * 判据：产物调用出现在某一轮 `turn_diff` 之前（即该轮正常收尾）⇒ 它的产物会进入结果卡，
 * 过程里不再单独出产物卡。没有 turn_diff 收尾的调用（运行中 / diff 失效）保留内联卡兜底，
 * 保证「正在写的东西」在结果卡出现前也看得见。
 * @param events 事件数组
 * @returns 已被结果卡收编的 tool_call id 集合
 */
export function collectTurnSummaryCalls(events: readonly ThreadEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  let pending = new Set<string>();
  for (const ev of events) {
    if (ev.type === 'tool_call' && isArtifactCall(ev)) pending.add(callIdOf(ev));
    else if (ev.type === 'turn_diff') {
      pending.forEach((id) => ids.add(id));
      pending = new Set<string>();
    }
  }
  return ids;
}

/**
 * 按 `turn_diff` 切出每轮事件切片（**原始事件**，含被渲染层内联隐藏的 tool_result）。
 *
 * 结果卡要用 tool_result 的文本回读草图路径（sketch_write），所以切片不能只拿「可见事件」——
 * 那会把已内联的结果滤掉，图片产物就永远补不进结果卡。
 * @param events 原始事件数组
 * @returns turn_diff 事件 id → 该轮事件切片（含本轮 turn_diff）
 */
function turnSummarySegments(events: readonly ThreadEvent[]): ReadonlyMap<string, readonly ThreadEvent[]> {
  const out = new Map<string, readonly ThreadEvent[]>();
  let segment: ThreadEvent[] = [];
  for (const ev of events) {
    segment.push(ev);
    if (ev.type === 'turn_diff') {
      out.set(ev.id, segment);
      segment = [];
    }
  }
  return out;
}

/**
 * 把 events 拆成可视块：**先剔除不会渲染的事件**（见 {@link isRenderedEvent}）。
 *
 * 规则：
 *  - `turn_diff` 收口成 `turn_summary` 块，并把本轮事件切片交给结果卡做汇总；
 *  - 运行中（busy=true）只把工具调用/结果折成一行「执行中」摘要，思考保留实时面板；
 *  - 空闲时 reasoning/tool_call/tool_result 照旧聚合；**已收编进结果卡**的产物调用也聚合，
 *    没被收编的产物调用仍单独成块并带内联产物卡（运行中 / 无 diff 的兜底路径）。
 * @param events 事件数组
 * @param busy 回合是否进行中
 * @param summarizedCallIds 已收编进结果卡的产物调用 id（缺省现算）
 * @returns 可视块列表
 */
export function buildDisplayBlocks(
  events: readonly ThreadEvent[],
  busy: boolean | undefined,
  summarizedCallIds?: ReadonlySet<string>,
): DisplayBlock[] {
  const summarized = summarizedCallIds ?? collectTurnSummaryCalls(events);
  const visible = events.filter((e) => isRenderedEvent(e, collectToolCallIds(events)));
  const segments = turnSummarySegments(events);
  const blocks: DisplayBlock[] = [];
  let buf: ThreadEvent[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const first = buf[0]!;
    blocks.push({
      kind: 'process',
      events: buf,
      key: first.id,
    } as ProcessBlock);
    buf = [];
  };
  for (const ev of visible) {
    if (ev.type === 'turn_diff') {
      flush();
      blocks.push({
        kind: 'turn_summary',
        key: ev.id,
        diffEvent: ev,
        events: segments.get(ev.id) ?? [ev],
      } as TurnSummaryBlock);
      continue;
    }
    // 运行中：思考仍是实时面板；工具调用与结果折成活动摘要（不再一条一行地铺开）。
    if (busy === true) {
      if (ev.type === 'tool_call' || ev.type === 'tool_result') {
        buf.push(ev);
        continue;
      }
      flush();
      blocks.push({ kind: 'single', event: ev } as SingleBlock);
      continue;
    }
    const artifact = isArtifactCall(ev);
    const keepInline = artifact && !summarized.has(callIdOf(ev));
    if (PROCESS_TYPES.has(ev.type) && !keepInline) {
      buf.push(ev);
    } else {
      flush();
      blocks.push({ kind: 'single', event: ev } as SingleBlock);
    }
  }
  flush();
  return blocks;
}

/** 过程动作分组（WorkBuddy 范式）：工具名 → 人话动词短语。 */
const ACTION_GROUPS: ReadonlyArray<{ readonly verbs: string; readonly test: (n: string) => boolean }> = [
  { verbs: '读取了 {n} 个文件', test: (n) => n === 'read_file' },
  { verbs: '写入了 {n} 个文件', test: (n) => n === 'write_file' },
  { verbs: '修改了 {n} 个文件', test: (n) => n === 'apply_patch' },
  { verbs: '生成了 {n} 张草图', test: (n) => n === 'sketch_write' },
  { verbs: '执行了 {n} 条命令', test: (n) => n === 'shell' || n === 'bash' },
  { verbs: '浏览了 {n} 次目录', test: (n) => n === 'list_dir' },
  { verbs: '搜索了 {n} 次', test: (n) => n === 'search' || n === 'grep' },
  { verbs: '委派了 {n} 个子任务', test: (n) => n === 'delegate' || n === 'subagent' },
  { verbs: '更新了 {n} 次计划', test: (n) => n.startsWith('plan_') || n === 'todo_write' },
];

/** 过程块 summary 文本（叙述式）：「思考 3 次 · 读取了 2 个文件 · 执行了 5 条命令」。 */
export function processSummary(events: readonly ThreadEvent[]): string {
  let thinkCount = 0;
  const toolCounts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === 'reasoning') {
      thinkCount++;
    } else if (ev.type === 'tool_call') {
      const name = (ev.payload?.name as string) || 'tool';
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
    }
  }
  const parts: string[] = [];
  if (thinkCount > 0) parts.push(t('思考 {n} 次', { n: thinkCount }));
  const grouped = new Set<string>();
  for (const g of ACTION_GROUPS) {
    let n = 0;
    for (const [name, c] of toolCounts) {
      if (g.test(name)) {
        n += c;
        grouped.add(name);
      }
    }
    if (n > 0) parts.push(t(g.verbs, { n }));
  }
  const rest = Array.from(toolCounts.entries())
    .filter(([name]) => !grouped.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [name, n] of rest) parts.push(t('{name}×{n}', { name, n }));
  return parts.length > 0 ? parts.join(' · ') : t('{n} 个事件', { n: events.length });
}

/** 变更状态 → 中文徽章（ChangesTab 复用）。 */
export function statusBadge(st: string): { label: string; cls: string } {
  if (st === '??' || st === 'A') return { label: t('新增'), cls: 'add' };
  if (st === 'D') return { label: t('删除'), cls: 'del' };
  if (st === 'R') return { label: t('重命名'), cls: 'ren' };
  return { label: t('修改'), cls: 'mod' };
}

/**
 * 把 unified diff 解析成 hunk 列表（供内联审查：hunk 级复制 / 定位）。
 * 每个 hunk 含头部（@@ ... @@）与行（带 +/-/空格 前缀）。解析失败返回空数组（fail-closed）。
 */
export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}
/** 解析期的可变累加器；对外仍以只读 DiffHunk 暴露，避免调用方误改。 */
interface MutableHunk {
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
}
export function parseHunks(patch: string): DiffHunk[] {
  if (!patch) return [];
  const lines = patch.split('\n');
  const hunks: MutableHunk[] = [];
  let cur: MutableHunk | null = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push(cur);
      cur = { header: line, lines: [], additions: 0, deletions: 0 };
      continue;
    }
    // hunk 体只统计其后的 +/- 行（直到下一个 @@ 或文件结束）。
    if (cur) {
      cur.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) cur.additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) cur.deletions++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** 相对时间（ISO 时间戳 → 「刚刚 / N 分钟前 / …」；无效输入返回空串）。 */
/**
 * 相对时间（「刚刚」/「3 分钟前」/「2 小时前」/「5 天前」）。
 *
 * `now` 可注入是**判据需要**：会话行现在内联显示相对时间，而"用墙钟算相对时间"的判据在
 * 毫秒跨界时会偶发假红（本仓 §8.0 的仪器教训）。注入受控时刻后同一输入恒同输出。
 * @param iso ISO 时间串（缺省 / 不可解析时返回空串，调用方据此不渲染这一格）
 * @param now 参照时刻（毫秒；缺省墙钟）
 * @returns 相对时间文案
 */
export function timeAgo(iso?: string, now: number = Date.now()): string {
  if (!iso) return '';
  // ⚠️ 变量名不可叫 `t`：本模块 import 了 i18n 的 `t()`，用一个数值 `t` 接 Date.parse
  // 会把翻译函数**遮蔽**掉，于是同一个函数体里的 `t('刚刚')` 变成"把 Number 当函数调用"
  // （TS2349，2026-10-17 实际编译失败）。改名 `ts`（timestamp）后两者互不干扰。
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) });
  return t('{n} 天前', { n: Math.floor(s / 86400) });
}

/** 单行 diff 行（含行号锚点，供行内评论定位）。 */
export interface DiffRow {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
  text: string;
  /** 旧文件行号（'-' 行与上下文行）。 */
  oldNo?: number;
  /** 新文件行号（'+' 行与上下文行）。 */
  newNo?: number;
}

/**
 * 把 unified diff 展开为带行号的行序列（ChangesTab 行内评论锚点用）。
 * 头部行归 meta；@@ 行归 hunk 并更新后续行号计数；无 @@ 的新文件全 + 补丁
 * （untracked 服务器构造）按行号 1 起算。解析失败返回空数组（fail-closed）。
 */
export function parseDiffRows(patch: string): DiffRow[] {
  if (!patch) return [];
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let sawHunk = false;
  const META = /^(?:diff |index |--- |\+\+\+ |new file|old mode|similarity |rename |deleted file|new mode|copy )/;
  for (const line of patch.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('@@')) {
      sawHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!sawHunk && META.test(line)) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      rows.push({ kind: 'add', text: line, newNo: sawHunk ? newNo++ : ++newNo });
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      rows.push({ kind: 'del', text: line, oldNo: sawHunk ? oldNo++ : ++oldNo });
      continue;
    }
    // 上下文行（' ' 前缀或 hunk 内空行）：新旧文件同时存在。
    if (sawHunk) {
      rows.push({ kind: 'ctx', text: line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}
