// 回合结果汇总（纯模型，零 React）：把一轮里「生成的文件」与「修改的文件」收拢成一份清单。
//
// 数据来源只有一个：
//   1. `turn_diff` 事件（回合结束时由 TurnDiffTracker 产出的整回合 unified diff）——改动文件的事实源；
//   2. 本轮写类工具（write_file / apply_patch / sketch_write）的成功回执——补上 turn_diff 覆盖不到的
//      产物（典型是 sketch_write 的图片：它不进 diff）。
//
// 两者按路径去重：diff 里出现过的文件一律以 diff 为准（有增删行数与正文），只有 diff 没覆盖到的产物
// 才作为「artifact-only」行补充。这样界面不会把同一个文件在过程卡与结果卡里各列一遍。
//
// 生成 / 修改的分组判据：
//   · diff 行看 hunk 旧侧行数是否为 0（`created`，见 TurnDiffFiles）；
//   · artifact-only 行按工具语义兜底：apply_patch → 修改，write_file / sketch_write → 生成。

import { ArtifactResolver, type ArtifactKind } from './ArtifactResolver.ts';
import { parseTurnDiffFiles } from './TurnDiffFiles.ts';
import type { ThreadEvent } from '../../types/models.ts';

/** 结果行分组：本回合生成的新文件 / 本回合修改的已有文件。 */
export type TurnSummaryGroup = 'created' | 'modified';

/** 结果卡里的一行文件。 */
export interface TurnSummaryFile {
  /** 工作区相对路径（与 /files?path= 及右侧面板同一口径）。 */
  readonly path: string;
  /** 展示用文件名（路径末段）。 */
  readonly name: string;
  readonly group: TurnSummaryGroup;
  /** 新增行数；artifact-only 行为 0。 */
  readonly added: number;
  /** 删除行数；artifact-only 行为 0。 */
  readonly deleted: number;
  /** unified diff 正文；artifact-only 行为空串。 */
  readonly diff: string;
  /** 图标语义：文件 / 补丁 / 草图。 */
  readonly kind: ArtifactKind;
}

/** 一轮的完整结果汇总。 */
export interface TurnSummary {
  readonly files: readonly TurnSummaryFile[];
  readonly createdCount: number;
  readonly modifiedCount: number;
  readonly added: number;
  readonly deleted: number;
  /**
   * 本轮消耗时长（毫秒）：取本轮事件里最早的合法时间戳到最晚时间戳。
   *
   * 为什么从事件时间戳算而不是 UI 挂载时刻：历史会话回放时没有「挂载时刻」，
   * 而 user / turn_diff 事件的时间戳在落盘时就已固定；同一条判据对实时与历史都成立。
   * 时间戳缺失或全为 0（旧夹具）时为 0，卡片不显示时长。
   */
  readonly durationMs: number;
}

/**
 * 取事件的毫秒时间戳（兼容 number 与 ISO 字符串；无效值返回 0）。
 * @param ev 事件
 * @returns 毫秒时间戳；不可用时为 0
 */
function timestampOf(ev: ThreadEvent): number {
  const raw: unknown = ev.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/** 会产出文件、需要进结果汇总的工具（read_file / lsp_* 只是引用，不算产物）。 */
const SUMMARY_TOOLS: ReadonlySet<string> = new Set(['write_file', 'apply_patch', 'sketch_write']);

/** 工具结果视图（只取汇总需要的 ok 与文本）。 */
interface ToolResultInfo {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * 从事件流收集工具回执（历史会话与实时合并共用同一条通路）。
 * @param events 事件数组
 * @returns callId → 回执信息
 */
function collectResults(events: readonly ThreadEvent[]): ReadonlyMap<string, ToolResultInfo> {
  const out = new Map<string, ToolResultInfo>();
  for (const ev of events) {
    if (ev.type !== 'tool_result') continue;
    const p = ev.payload || {};
    const callId = typeof p.callId === 'string' ? p.callId : '';
    if (callId === '') continue;
    // 兼容两种历史形状：当前协议用 output/error，旧夹具/旧存档可能只给 text。
    const text =
      p.error != null
        ? '✗ ' + String(p.error)
        : p.output != null
          ? String(p.output)
          : p.text != null
            ? String(p.text)
            : '';
    out.set(callId, { ok: p.ok === true, text });
  }
  return out;
}

/**
 * 取路径末段作为展示文件名。
 * @param path 相对路径
 * @returns 文件名（无分隔符时即原串）
 */
function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * 把一轮事件汇总为结果清单。
 *
 * 同一个 `turn_diff` 之前的过程事件属于同一轮；调用方（buildDisplayBlocks）按 turn_diff 切段后
 * 把整段传进来即可。函数本身不关心轮次边界。
 * @param events 一轮的全部事件（含 turn_diff）
 * @returns 按「生成 → 修改」排序的结果汇总
 */
export function buildTurnSummary(events: readonly ThreadEvent[]): TurnSummary {
  let diff = '';
  for (const ev of events) {
    if (ev.type === 'turn_diff') diff = typeof ev.payload?.diff === 'string' ? ev.payload.diff : '';
  }

  const files: TurnSummaryFile[] = [];
  const seen = new Set<string>();

  // 1) diff 事实源：路径、增删、正文、是否新建全部以它为准。
  for (const f of parseTurnDiffFiles(diff)) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    files.push({
      path: f.path,
      name: baseName(f.path),
      group: f.created ? 'created' : 'modified',
      added: f.added,
      deleted: f.deleted,
      diff: f.text,
      kind: f.created ? 'file' : 'patch',
    });
  }

  // 2) diff 覆盖不到的产物（图片/草图等）：只有成功回执才登记，失败一律不展示。
  const results = collectResults(events);
  for (const ev of events) {
    if (ev.type !== 'tool_call') continue;
    const p = ev.payload || {};
    const name = typeof p.name === 'string' ? p.name : '';
    if (!SUMMARY_TOOLS.has(name)) continue;
    const callId = typeof p.callId === 'string' ? p.callId : ev.id;
    const res = results.get(callId);
    if (res === undefined || !res.ok) continue;
    const info = ArtifactResolver.fromTool(name, p.args, res.text);
    if (info === null || seen.has(info.relPath)) continue;
    seen.add(info.relPath);
    files.push({
      path: info.relPath,
      name: info.name,
      group: name === 'apply_patch' ? 'modified' : 'created',
      added: 0,
      deleted: 0,
      diff: '',
      kind: info.kind,
    });
  }

  // 生成的文件在前（那是这一轮的交付物），同组按路径稳定排序。
  const order: Readonly<Record<TurnSummaryGroup, number>> = { created: 0, modified: 1 };
  files.sort((a, b) => order[a.group] - order[b.group] || a.path.localeCompare(b.path));

  let createdCount = 0;
  let modifiedCount = 0;
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    if (f.group === 'created') createdCount += 1;
    else modifiedCount += 1;
    added += f.added;
    deleted += f.deleted;
  }

  // 本轮耗时：首尾事件时间戳之差（见 TurnSummary.durationMs 的口径说明）。
  let firstAt = 0;
  let lastAt = 0;
  for (const ev of events) {
    const at = timestampOf(ev);
    if (at === 0) continue;
    if (firstAt === 0 || at < firstAt) firstAt = at;
    if (at > lastAt) lastAt = at;
  }
  const durationMs = firstAt > 0 && lastAt > firstAt ? lastAt - firstAt : 0;

  return { files, createdCount, modifiedCount, added, deleted, durationMs };
}
