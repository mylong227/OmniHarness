// 纯函数工具层（零 React / 零 DOM 依赖）：对话流与变更面板的文本/结构计算逻辑。
// 抽离出来便于在 node --test 下直接单测（web 此前 0 测试文件，审计 P0）。
// 注意：本文件不得 import '../deps.js'（它依赖浏览器全局 React），否则无法在 node 下加载。

import type { ThreadEvent } from '../types/models.js';

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
      return p ? `写入 ${p}` : '写入文件';
    }
    case 'apply_patch': {
      const p = pathOf();
      return p ? `修改 ${p}` : '修改文件';
    }
    case 'read_file': {
      const p = pathOf();
      return p ? `读取 ${p}` : '读取文件';
    }
    case 'list_dir': {
      const p = pathOf();
      return p ? `浏览目录 ${p}` : '浏览目录';
    }
    case 'shell':
    case 'bash': {
      const cmd = str('command') || str('cmd');
      return cmd ? `执行命令 ${short(cmd)}` : '执行命令';
    }
    case 'search':
    case 'grep': {
      const q = str('pattern') || str('query');
      return q ? `搜索 ${short(q, 48)}` : '搜索代码';
    }
    case 'plan_read':
      return '查看计划';
    case 'plan_write':
      return '更新计划';
    case 'plan_present':
      return '展示计划';
    case 'todo_write':
      return '更新待办';
    case 'delegate':
    case 'subagent': {
      const t = str('task') || str('prompt');
      return t ? `委派子任务 ${short(t, 48)}` : '委派子任务';
    }
    default: {
      const summary = argSummary(args);
      return summary ? `${name}（${summary}）` : `调用 ${name}`;
    }
  }
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
export type DisplayBlock = SingleBlock | ProcessBlock;

/** 把 events 拆成可视块：busy=true 时单 event 不折叠；busy=false 时把过程类打包成 process 块。 */
export function buildDisplayBlocks(events: readonly ThreadEvent[], busy: boolean | undefined): DisplayBlock[] {
  if (busy === true) {
    return events.map((e) => ({ kind: 'single', event: e } as SingleBlock));
  }
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
  for (const ev of events) {
    if (PROCESS_TYPES.has(ev.type)) {
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
  { verbs: '写入了 {n} 个文件', test: (n) => n === 'write_file' || n === 'apply_patch' },
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
  if (thinkCount > 0) parts.push(`思考 ${thinkCount} 次`);
  const grouped = new Set<string>();
  for (const g of ACTION_GROUPS) {
    let n = 0;
    for (const [name, c] of toolCounts) {
      if (g.test(name)) {
        n += c;
        grouped.add(name);
      }
    }
    if (n > 0) parts.push(g.verbs.replace('{n}', String(n)));
  }
  const rest = Array.from(toolCounts.entries())
    .filter(([name]) => !grouped.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [name, n] of rest) parts.push(`${name}×${n}`);
  return parts.length > 0 ? parts.join(' · ') : `${events.length} 个事件`;
}

/** 变更状态 → 中文徽章（ChangesTab 复用）。 */
export function statusBadge(st: string): { label: string; cls: string } {
  if (st === '??' || st === 'A') return { label: '新增', cls: 'add' };
  if (st === 'D') return { label: '删除', cls: 'del' };
  if (st === 'R') return { label: '重命名', cls: 'ren' };
  return { label: '修改', cls: 'mod' };
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
export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
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
