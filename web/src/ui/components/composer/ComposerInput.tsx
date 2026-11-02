// 输入区正文：`@` / `/` 补全弹层 + 非受控 textarea。
//
// 非受控 textarea（值由 ComposerDraft / 语音 / 补全直接写 DOM），所以这里不持有任何状态：
// 只接 ref、补全接口与事件。弹层是「无补全即返回 null」的组件，DOM 结构与原内联渲染一致
// （class / role / aria-label / 防失焦的 mousedown 全部照搬）。

import * as React from 'react';
import { t } from '../../i18n/i18n.ts';
import { handleComposerKeyDown } from './composerKeyboard.ts';
import type { ComposerCompletions } from './useComposerCompletions.ts';
import type { MentionState, SkillOption, SlashState } from './composerCompletions.ts';

/** `/` 技能补全弹层的入参。 */
export interface SlashSuggestionPopProps {
  /** 补全态；null 时不渲染。 */
  readonly slash: SlashState | null;
  /** 选中回调（插入 `/name `）。 */
  readonly onPick: (item: SkillOption) => void;
}

/**
 * `/` 技能补全弹层：名称 + 描述，点击插入 `/name `。
 * @param props 组件入参
 * @returns 弹层节点；无补全时为 null
 */
export function SlashSuggestionPop(props: SlashSuggestionPopProps): ReactElement | null {
  const { slash, onPick } = props;
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

/** `@` 文件引用补全弹层的入参。 */
export interface MentionSuggestionPopProps {
  /** 补全态；null 时不渲染。 */
  readonly mention: MentionState | null;
  /** 选中回调（插入 `@path `）。 */
  readonly onPick: (path: string) => void;
}

/**
 * `@mention` 补全弹层：列出候选路径，点击（mousedown 防失焦）即插入。
 * @param props 组件入参
 * @returns 弹层节点；无补全时为 null
 */
export function MentionSuggestionPop(props: MentionSuggestionPopProps): ReactElement | null {
  const { mention, onPick } = props;
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

/** 输入区正文的入参。 */
export interface ComposerInputProps {
  /** 非受控 textarea 引用（补全 / 语音 / 发送都直接读写 DOM 值）。 */
  readonly taRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 占位符（随聊天模式变化）。 */
  readonly placeholder: string;
  /** 补全接口（弹层 + 键盘接管）。 */
  readonly completions: ComposerCompletions;
  /** 粘贴：从中取文件附件。 */
  readonly onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** 提交（Enter 发送 / 插话按钮）。 */
  readonly onSubmit: () => void;
}

/**
 * 输入区正文：补全弹层 + textarea（正文在上，控制行由 ComposerToolbar 承接）。
 * @param props 组件入参
 * @returns 输入区节点
 */
export function ComposerInput(props: ComposerInputProps): ReactElement {
  const { taRef, placeholder, completions, onPaste, onSubmit } = props;
  return (
    <div className="composer-input">
      <SlashSuggestionPop slash={completions.slash} onPick={completions.applySlash} />
      <MentionSuggestionPop mention={completions.mention} onPick={completions.applyMention} />
      <textarea
        id="prompt"
        rows={1}
        ref={taRef}
        aria-label={t('任务输入框：输入任务，Enter 发送，Shift+Enter 换行，@ 引用文件，/ 选择技能')}
        placeholder={placeholder}
        onPaste={onPaste}
        onInput={completions.refresh}
        onClick={completions.refresh}
        onKeyDown={(e: React.KeyboardEvent) => handleComposerKeyDown(e, completions, onSubmit)}
      ></textarea>
    </div>
  );
}
