// 输入区补全的 hook 层：`@mention`（文件路径）与 `/`（技能）两类补全的状态与操作。
//
// 拆自 Composer（S2 长函数清偿）：原组件里「补全 state + 拉取 + 选中改写」共 ~70 行，
// 现在拆成两个只看 textarea 与 ApiClient 的子 hook，外加一个合并入口；
// 组件层只接 `ComposerCompletions` 这一个对象（键盘处理见 `composerKeyboard.ts`）。

import * as React from 'react';
import { MentionResolver } from '../../models/MentionResolver.ts';
import { SlashResolver } from '../../models/SlashResolver.ts';
import { ComposerDraft } from '../../models/ComposerDraft.ts';
import { FileTreeFlattener } from '../../models/FileTreeFlattener.ts';
import type { ComposerSeed } from '../../shared.ts';
import type { ApiClient } from '../../../core/ApiClient.ts';
import {
  growComposerTextarea,
  insertMentionText,
  insertSlashText,
  mentionStateOf,
  slashStateOf,
  type MentionState,
  type SkillOption,
  type SlashState,
} from './composerCompletions.ts';

/** 补全 hook 的公共入参。 */
export interface CompletionsOptions {
  /** ApiClient（文件树 / 技能清单首次触发时各拉一次）。 */
  readonly api: ApiClient;
  /** 非受控输入框引用。 */
  readonly taRef: React.RefObject<HTMLTextAreaElement | null>;
}

/** `@mention` 补全接口。 */
export interface MentionCompletions {
  readonly mention: MentionState | null;
  readonly setMention: (next: MentionState | null) => void;
  /** 从光标位置重算候选。 */
  readonly refresh: () => void;
  /** 选中候选：把 `@token` 换成 `@path `。 */
  readonly apply: (item: string) => void;
}

/** `/` 技能补全接口。 */
export interface SlashCompletions {
  readonly slash: SlashState | null;
  readonly setSlash: (next: SlashState | null) => void;
  /** 从光标位置重算候选；是否由 `/` 接管本次补全。 */
  readonly refresh: () => boolean;
  /** 选中候选：把 `/query` 换成 `/name `。 */
  readonly apply: (item: SkillOption) => void;
}

/** 输入区两类补全的合并接口（组件层只接这一个）。 */
export interface ComposerCompletions {
  readonly mention: MentionState | null;
  readonly slash: SlashState | null;
  readonly setMention: (next: MentionState | null) => void;
  readonly setSlash: (next: SlashState | null) => void;
  readonly applyMention: (item: string) => void;
  readonly applySlash: (item: SkillOption) => void;
  /** 输入/点击时统一刷新 `@` 与 `/` 补全（`/` 优先）。 */
  readonly refresh: () => void;
  /** 收起 @ / `/` 两类补全（发送与插话共用同一收尾）。 */
  readonly clearSuggest: () => void;
}

/**
 * `@mention` 补全：文件路径清单首次触发时拉一次并缓存。
 * @param o 入参（ApiClient + 输入框引用）
 * @returns 补全态与操作
 */
function useMentionCompletions(o: CompletionsOptions): MentionCompletions {
  const [mention, setMention] = React.useState<MentionState | null>(null);
  /** 文件路径缓存（@mention 数据源，首次触发时拉取一次）。 */
  const [fileCache, setFileCache] = React.useState<string[] | null>(null);

  /**
   * 从光标位置解析 @ 前缀 token，有则拉起 / 更新补全列表。
   * @returns 无
   */
  const refresh = (): void => {
    growComposerTextarea(o.taRef.current);
    const ta = o.taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart ?? 0;
    const token = MentionResolver.parse(ta.value.slice(0, pos), pos);
    if (!token) {
      setMention(null);
      return;
    }
    const applyPaths = (paths: readonly string[]): void =>
      setMention(mentionStateOf(paths, token));
    if (fileCache !== null) {
      applyPaths(fileCache);
      return;
    }
    o.api
      .listFs(4)
      .then((r) => {
        const paths = FileTreeFlattener.collect(r.tree ?? []);
        setFileCache(paths);
        applyPaths(paths);
      })
      .catch(() => setMention(null));
  };

  /**
   * 选中补全项：把 @token 替换为 `@path `。
   * @param item 选中路径
   * @returns 无
   */
  const apply = (item: string): void => {
    const ta = o.taRef.current;
    if (!ta || !mention) return;
    insertMentionText(ta, mention, item);
    setMention(null);
    ta.focus();
  };

  return { mention, setMention, refresh, apply };
}

/**
 * `/` 技能补全：技能清单首次触发时拉一次并缓存。
 * @param o 入参（ApiClient + 输入框引用 + 收起 @ 补全的回调）
 * @returns 补全态与操作
 */
function useSlashCompletions(
  o: CompletionsOptions & { readonly clearMention: (next: MentionState | null) => void },
): SlashCompletions {
  const [slash, setSlash] = React.useState<SlashState | null>(null);
  /** 技能清单缓存（首次 `/` 时拉取一次）。 */
  const [skillCache, setSkillCache] = React.useState<SkillOption[] | null>(null);

  /**
   * 解析 `/` 技能前缀；命中时拉取/过滤技能并返回 true。
   * @returns 是否由 `/` 接管本次补全
   */
  const refresh = (): boolean => {
    const ta = o.taRef.current;
    if (!ta) return false;
    const pos = ta.selectionStart ?? 0;
    const token = SlashResolver.parse(ta.value, pos);
    if (token === null) {
      setSlash(null);
      return false;
    }
    o.clearMention(null);
    const applySkills = (skills: readonly SkillOption[]): void =>
      setSlash(slashStateOf(skills, token));
    if (skillCache !== null) {
      applySkills(skillCache);
      return true;
    }
    o.api
      .listSkills()
      .then((r) => {
        const skills = r.skills ?? [];
        setSkillCache(skills);
        applySkills(skills);
      })
      .catch(() => setSlash(null));
    return true;
  };

  /**
   * 选中技能：把 `/query` 替换为 `/name `。
   * @param item 选中技能
   * @returns 无
   */
  const apply = (item: SkillOption): void => {
    const ta = o.taRef.current;
    if (!ta || slash === null) return;
    insertSlashText(ta, slash, item);
    setSlash(null);
    ta.focus();
  };

  return { slash, setSlash, refresh, apply };
}

/**
 * 输入区补全（`@` 文件 / `/` 技能）：把两个子 hook 合成组件层唯一入口。
 * @param o 入参（ApiClient + 输入框引用）
 * @returns 合并后的补全接口
 */
export function useComposerCompletions(o: CompletionsOptions): ComposerCompletions {
  const mention = useMentionCompletions(o);
  const slash = useSlashCompletions({
    api: o.api,
    taRef: o.taRef,
    clearMention: mention.setMention,
  });

  /** 收起 @ / `/` 两类补全。 @returns 无 */
  const clearSuggest = (): void => {
    mention.setMention(null);
    slash.setSlash(null);
  };

  /** 输入/点击时统一刷新 `@` 与 `/` 补全（`/` 优先）。 @returns 无 */
  const refresh = (): void => {
    growComposerTextarea(o.taRef.current);
    if (!slash.refresh()) mention.refresh();
  };

  return {
    mention: mention.mention,
    slash: slash.slash,
    setMention: mention.setMention,
    setSlash: slash.setSlash,
    applyMention: mention.apply,
    applySlash: slash.apply,
    refresh,
    clearSuggest,
  };
}

/**
 * F4「编辑重发」：外部把末条用户消息填回输入框（seed.nonce 变化即触发一次回填）。
 * @param seed 回填指令（null/undefined 时不动）
 * @param taRef 输入框引用
 * @param clearSuggest 收起补全
 * @returns 无
 */
export function useComposerSeed(
  seed: ComposerSeed | null | undefined,
  taRef: React.RefObject<HTMLTextAreaElement | null>,
  clearSuggest: () => void,
): void {
  React.useEffect(() => {
    if (seed === undefined || seed === null) return;
    ComposerDraft.fill(taRef.current, seed.text);
    growComposerTextarea(taRef.current);
    clearSuggest();
  }, [seed]);
}
