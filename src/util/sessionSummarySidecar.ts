/**
 * 会话旁路摘要文件（`<session>.jsonl.summary.json`）。
 *
 * ## 为什么旁路
 *
 * `sessions.list` 原先对每个 `.jsonl` 整档读取 + 逐行 `JSON.parse` 只为算几个汇总字段；
 * 409 个会话本机冷缓存实测 4.7 s。旁路文件只有几百字节，且带 `size` 校验：
 * 文件大小未变 ⇒ 摘要必然对应同一份内容，列表可**完全不读 `.jsonl`**。
 *
 * ## 契约
 *
 * - 位置：与 `.jsonl` 同目录，文件名 `${jsonl 文件名}.summary.json`（不会被 `.jsonl` 扫描面收进）；
 * - 形状：`{ version: 1, size: <jsonl 字节数>, summary: {...} }`；
 * - 校验：版本/形状/`size` 任一不符 ⇒ 视为**没有旁路**，调用方回落逐行解析；
 * - 写入：同目录 tmp + rename 原子替换；写失败只告警（旁路是优化，不是事实源）。
 *
 * ## 诚实边界
 *
 * 大小相同但内容被替换（极端的原地改写）时旁路会陈旧。会话存档是 append-only，
 * 正常路径下 size 单调增；若将来引入原地改写，必须同时 bump `version`。
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { SessionSummary } from './sessionSummary.ts';

/** 旁路文件格式版本。 */
const SUMMARY_VERSION = 1;

/** 旁路文件内容。 */
interface SummaryPayload {
  readonly version: number;
  /** 对应 `.jsonl` 的字节数。 */
  readonly size: number;
  /** 摘要。 */
  readonly summary: SessionSummary;
}

/** 读取结果（调用方用 size 与当前文件大小比对）。 */
export interface StoredSessionSummary {
  /** 写入旁路时 `.jsonl` 的字节数。 */
  readonly size: number;
  /** 摘要。 */
  readonly summary: SessionSummary;
}

/**
 * 旁路文件路径。
 * @param jsonlFile `.jsonl` 绝对路径。
 * @returns 旁路文件绝对路径。
 */
export const sessionSummaryPath = (jsonlFile: string): string => `${jsonlFile}.summary.json`;

/**
 * 校验 JSON 是否为合法旁路负载。
 * @param value 解析后的值。
 * @returns 合法时为负载；否则 undefined。
 */
const parsePayload = (value: unknown): SummaryPayload | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw['version'] !== SUMMARY_VERSION) return undefined;
  const size = raw['size'];
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
  const summary = raw['summary'];
  if (summary === null || typeof summary !== 'object') return undefined;
  const s = summary as Record<string, unknown>;
  if (typeof s['mock'] !== 'boolean') return undefined;
  if (typeof s['label'] !== 'string') return undefined;
  if (typeof s['turns'] !== 'number' || !Number.isFinite(s['turns'])) return undefined;
  if (typeof s['updatedAt'] !== 'string') return undefined;
  if (typeof s['activeMs'] !== 'number' || !Number.isFinite(s['activeMs'])) return undefined;
  if (typeof s['idleGaps'] !== 'number' || !Number.isFinite(s['idleGaps'])) return undefined;
  if (s['workspace'] !== undefined && typeof s['workspace'] !== 'string') return undefined;
  if (s['model'] !== undefined && typeof s['model'] !== 'string') return undefined;
  return {
    version: SUMMARY_VERSION,
    size,
    summary: {
      ...(typeof s['workspace'] === 'string' ? { workspace: s['workspace'] } : {}),
      ...(typeof s['model'] === 'string' ? { model: s['model'] } : {}),
      mock: s['mock'],
      label: s['label'],
      turns: s['turns'],
      updatedAt: s['updatedAt'],
      activeMs: s['activeMs'],
      idleGaps: s['idleGaps'],
    },
  };
};

/**
 * 读旁路摘要（缺文件/坏 JSON/版本不符一律返回 undefined，不抛错）。
 * @param jsonlFile `.jsonl` 绝对路径。
 * @returns 旁路负载；不可用时 undefined。
 */
export const readSessionSummary = async (
  jsonlFile: string,
): Promise<StoredSessionSummary | undefined> => {
  try {
    const text = await readFile(sessionSummaryPath(jsonlFile), 'utf8');
    const parsed = parsePayload(JSON.parse(text) as unknown);
    return parsed === undefined ? undefined : { size: parsed.size, summary: parsed.summary };
  } catch {
    return undefined;
  }
};

/**
 * 写旁路摘要（原子替换；失败静默返回 false，绝不阻断主流程）。
 * @param jsonlFile `.jsonl` 绝对路径。
 * @param size 当前 `.jsonl` 字节数。
 * @param summary 摘要。
 * @returns 写入成功为 true。
 */
export const writeSessionSummary = async (
  jsonlFile: string,
  size: number,
  summary: SessionSummary,
): Promise<boolean> => {
  const target = sessionSummaryPath(jsonlFile);
  const tmp = `${target}.${String(process.pid)}.tmp`;
  const payload: SummaryPayload = { version: SUMMARY_VERSION, size, summary };
  try {
    await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    await rename(tmp, target);
    return true;
  } catch {
    await unlink(tmp).catch(() => undefined);
    return false;
  }
};
