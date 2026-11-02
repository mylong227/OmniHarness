// 输入区补全的纯逻辑层：`@mention`（文件）与 `/`（技能）两类补全的「态」与「文本改写」。
//
// 为什么单独成文件：这些换算只依赖 textarea 的值/光标与两个解析器（MentionResolver /
// SlashResolver），与 React 状态无关，可直接单测；`useComposerCompletions` 只负责把
// useState 接上它们（原实现里这两段各占 Composer 组件体 ~30 行）。

import { MentionResolver, type MentionToken } from '../../models/MentionResolver.ts';
import { SlashResolver, type SlashToken } from '../../models/SlashResolver.ts';

/** @mention 补全态。 */
export interface MentionState {
  /** `@` 在输入框全文中的下标。 */
  start: number;
  items: string[];
  idx: number;
}

/** `/` 技能候选。 */
export interface SkillOption {
  name: string;
  description: string;
  tags: string[];
}

/** `/` 技能补全态。 */
export interface SlashState {
  /** 当前 token（选中后用于替换）。 */
  token: SlashToken;
  items: SkillOption[];
  idx: number;
}

/**
 * 输入框随内容增高：空态一行，最多 140px（与 CSS max-height 一致）。
 *
 * 非受控 textarea 在输入 / @ 回填 / 语音写入 / 发送清空后都要重算，否则高度会停在旧值。
 * @param ta 目标输入框（尚未挂载时传 null）
 * @returns 无
 */
export function growComposerTextarea(ta: HTMLTextAreaElement | null): void {
  if (ta === null) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

/**
 * 按 `@` 查询词过滤候选路径，并折算成补全态。
 * @param paths 全部候选路径
 * @param token 解析出的 `@token`
 * @returns 补全态；无候选时返回 null（弹层收起）
 */
export function mentionStateOf(paths: readonly string[], token: MentionToken): MentionState | null {
  const items = MentionResolver.filter(paths, token.query);
  return items.length > 0 ? { start: token.start, items, idx: 0 } : null;
}

/**
 * 按 `/` 查询串过滤技能清单，并折算成补全态。
 * @param skills 技能清单
 * @param token 解析出的 `/token`
 * @returns 补全态；无候选时返回 null（弹层收起）
 */
export function slashStateOf(skills: readonly SkillOption[], token: SlashToken): SlashState | null {
  const items = SlashResolver.filter(skills, token.query);
  return items.length > 0 ? { token, items, idx: 0 } : null;
}

/**
 * 把输入框里的 `@token` 替换为 `@path `（保留光标之后的文本），并重算高度。
 * @param ta 输入框
 * @param mention 当前 @ 补全态（提供 `@` 的起点）
 * @param item 选中的路径
 * @returns 无
 */
export function insertMentionText(
  ta: HTMLTextAreaElement,
  mention: MentionState,
  item: string,
): void {
  const pos = ta.selectionStart ?? 0;
  const v = ta.value;
  ta.value = v.slice(0, mention.start) + '@' + item + ' ' + v.slice(pos);
  growComposerTextarea(ta);
}

/**
 * 把输入框里的 `/query` 替换为 `/name `，光标落到插入点之后，并重算高度。
 * @param ta 输入框
 * @param slash 当前 `/` 补全态（提供 token）
 * @param item 选中的技能
 * @returns 无
 */
export function insertSlashText(ta: HTMLTextAreaElement, slash: SlashState, item: SkillOption): void {
  const pos = ta.selectionStart ?? 0;
  const next = SlashResolver.apply(ta.value, slash.token, item.name, pos);
  ta.value = next.text;
  ta.selectionStart = next.caret;
  ta.selectionEnd = next.caret;
  growComposerTextarea(ta);
}
