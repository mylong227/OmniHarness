// 提问卡：服务端 `question.request` 上行时，在输入框正上方渲染的可作答卡片（2026-10-08）。
//
// 为什么必须有它：在此之前 Web 端对提问只有「只读卡」——选项按钮恒 disabled，没有任何提交入口，
// 用户看得见问题却答不了，回合只能等服务端超时、或到服务端终端里去答。本组件是提问的**唯一作答面**：
// 选项即控件（单选/多选）、自由输入可补充、提交走 `question.respond`。
//
// 状态归属：作答草稿留在本组件（随卡片卸载丢弃），「有没有待作答的提问」由 AppController 持有。
// 纯视图组件：不直接 fetch，RPC 经 onSubmit 回调上抛。

import { React } from '../deps.js';
import { icon } from '../models/Icon.js';
import type {
  AskQuestionItem,
  QuestionAnswerSubmission,
  QuestionRequest,
} from '../../types/models.js';

/** 倒计时步长（毫秒）。 */
const TICK_MS = 1000;

/** QuestionCard 组件的入参。 */
export interface QuestionCardProps {
  /** 待作答的提问（来自 `question.request` 通知）。 */
  request: QuestionRequest;
  /** 提交作答（由 AppController 走 `question.respond`）。 */
  onSubmit: (answers: QuestionAnswerSubmission[]) => Promise<void>;
  /** 等待到期（倒计时归零）：服务端会按「未作答」继续。 */
  onExpire: (requestId: string) => void;
}

/** 单题草稿：已选标签 + 自由输入。 */
interface Draft {
  selected: string[];
  custom: string;
}

/** 空草稿（未作答）。 */
const EMPTY_DRAFT: Draft = { selected: [], custom: '' };

/**
 * 一题的草稿是否算「已作答」：选了任一选项，或写了非空自由输入。
 * @param draft 该题草稿
 * @returns 已作答为 true
 */
function answered(draft: Draft | undefined): boolean {
  return draft !== undefined && (draft.selected.length > 0 || draft.custom.trim() !== '');
}

/**
 * 一道题的作答控件（选项 + 自由输入）。
 * @param props 题目、草稿、是否禁用与两个变更回调
 * @returns 题目节点
 */
function QuestionField(props: {
  item: AskQuestionItem;
  draft: Draft;
  disabled: boolean;
  onToggle: (label: string) => void;
  onCustom: (text: string) => void;
}): ReactElement {
  const { item, draft, disabled, onToggle, onCustom } = props;
  const multiple = item.multiSelect === true;
  const options = item.options ?? [];
  const title = item.header === undefined || item.header === '' ? item.question : item.header;
  return (
    <div className="qask-item">
      {item.header === undefined || item.header === '' ? null : (
        <div className="qask-eyebrow">{item.header}</div>
      )}
      <div className="qask-question" id={'qask-' + item.id}>
        {item.question}
      </div>
      {options.length === 0 ? null : (
        <div
          className="qask-options"
          role={multiple ? 'group' : 'radiogroup'}
          aria-labelledby={'qask-' + item.id}
        >
          {options.map((option) => {
            const checked = draft.selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                className={'qask-option' + (checked ? ' is-checked' : '')}
                role={multiple ? 'checkbox' : 'radio'}
                aria-checked={checked}
                disabled={disabled}
                onClick={() => onToggle(option.label)}
              >
                <span className={'qask-mark' + (multiple ? ' is-box' : '')} aria-hidden="true">
                  {checked ? (
                    multiple ? (
                      icon('check', { size: 12 })
                    ) : (
                      <span className="qask-mark-dot" />
                    )
                  ) : null}
                </span>
                <span className="qask-option-copy">
                  <span className="qask-option-label">{option.label}</span>
                  {option.description === undefined ? null : (
                    <span className="qask-option-desc">{option.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <input
        className="qask-custom"
        type="text"
        value={draft.custom}
        disabled={disabled}
        placeholder={options.length === 0 ? '输入你的回答' : '其他 / 补充说明（可选）'}
        aria-label={title + ' — 补充说明'}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onCustom(event.target.value)}
      />
    </div>
  );
}

/**
 * 可作答的提问卡：逐题给选项与自由输入，全部作答后提交。
 *
 * 为什么「全部作答」才可提交：服务端允许部分作答（未作答的题按空回答回填），但半空白的作答会让模型
 * 在「用户没看见」与「用户不想答」之间瞎猜。故默认要求完整，同时保留「全部跳过」这一显式出口
 * （明确表示不回答，而不是被迫作答）。
 * @param props 提问、提交回调与到期回调
 * @returns 提问卡节点
 */
export function QuestionCard(props: QuestionCardProps): ReactElement {
  const { request, onSubmit, onExpire } = props;
  /** 逐题草稿（题 id → 选择与自由输入）。 */
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  /** 提交中（禁用全部控件，防重复提交）。 */
  const [busy, setBusy] = React.useState(false);
  /** 校验/提交错误（就近显示在页脚）。 */
  const [error, setError] = React.useState<string | null>(null);
  /** 剩余等待毫秒（0 = 不限时，不显示倒计时）。 */
  const [remaining, setRemaining] = React.useState(
    request.timeoutMs !== undefined && request.timeoutMs > 0 ? request.timeoutMs : 0,
  );
  const total = request.questions.length;
  const done = request.questions.filter((item) => answered(drafts[item.id])).length;

  // 倒计时：每秒扣一步，归零时通知外层收卡（服务端在同一上限按「未作答」继续）。
  React.useEffect(() => {
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setRemaining(remaining - TICK_MS);
      if (remaining - TICK_MS <= 0) onExpire(request.requestId);
    }, TICK_MS);
    return () => window.clearTimeout(timer);
  }, [remaining, request.requestId, onExpire]);

  /**
   * 勾选/取消一个选项（单选互斥且可取消，多选累加）。
   * @param itemId 题 id
   * @param label 选项标签
   * @param multiple 该题是否多选
   * @returns 无
   */
  const toggle = (itemId: string, label: string, multiple: boolean): void => {
    setError(null);
    setDrafts((prev) => {
      const draft = prev[itemId] ?? EMPTY_DRAFT;
      const selected = multiple
        ? draft.selected.includes(label)
          ? draft.selected.filter((item) => item !== label)
          : [...draft.selected, label]
        : draft.selected.includes(label)
          ? []
          : [label];
      return { ...prev, [itemId]: { selected, custom: draft.custom } };
    });
  };

  /**
   * 写入某题的自由输入（与已选选项并存，作为补充说明）。
   * @param itemId 题 id
   * @param text 输入文本
   * @returns 无
   */
  const editCustom = (itemId: string, text: string): void => {
    setError(null);
    setDrafts((prev) => {
      const draft = prev[itemId] ?? EMPTY_DRAFT;
      return { ...prev, [itemId]: { selected: draft.selected, custom: text } };
    });
  };

  /**
   * 提交当前草稿（要求全部作答）。
   * @returns 无
   */
  const submit = async (): Promise<void> => {
    const missing = request.questions.findIndex((item) => !answered(drafts[item.id]));
    if (missing >= 0) {
      setError('第 ' + String(missing + 1) + ' 题还没作答：请选一项或填写补充说明。');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(
        request.questions.map((item) => {
          const draft = drafts[item.id] ?? EMPTY_DRAFT;
          return { id: item.id, selected: draft.selected, custom: draft.custom.trim() };
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * 全部跳过：显式不回答（让模型知道这是「选择不答」，而不是「没看见」）。
   * @returns 无
   */
  const skipAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSubmit(request.questions.map((item) => ({ id: item.id, selected: [] })));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="qask" aria-label="待回答的提问">
      <header className="qask-head">
        <span className="badge b-question">提问</span>
        <span className="qask-progress">
          已作答 {String(done)}/{String(total)}
        </span>
        {remaining > 0 ? (
          <span className="qask-timer">剩余 {String(Math.ceil(remaining / 1000))} 秒</span>
        ) : null}
      </header>
      <div className="qask-body">
        {request.questions.map((item) => (
          <QuestionField
            key={item.id}
            item={item}
            draft={drafts[item.id] ?? EMPTY_DRAFT}
            disabled={busy}
            onToggle={(label) => toggle(item.id, label, item.multiSelect === true)}
            onCustom={(text) => editCustom(item.id, text)}
          />
        ))}
      </div>
      <footer className="qask-foot">
        <span className="qask-hint">
          {remaining > 0
            ? '超时后模型会按「未作答」继续；作答随时可提交。'
            : '选择或填写后提交。'}
        </span>
        {error === null ? null : (
          <span className="qask-error" role="alert">
            {error}
          </span>
        )}
        <span className="flex-spacer" aria-hidden="true"></span>
        <button type="button" className="qask-skip" disabled={busy} onClick={() => void skipAll()}>
          全部跳过
        </button>
        <button
          type="button"
          className="qask-submit"
          disabled={busy || done < total}
          onClick={() => void submit()}
        >
          {busy ? '提交中…' : '提交回答'}
        </button>
      </footer>
    </section>
  );
}
