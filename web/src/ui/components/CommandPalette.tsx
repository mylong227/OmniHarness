// 命令面板：Ctrl+P / Ctrl+K 唤起，键盘可达的命令与导航中心。
//
// 面向对象拆分：
// - `CommandPaletteModel`：搜索过滤与选中边界的纯逻辑，零 React 依赖（可单测）。
// - `CommandPalette`：函数组件，只负责状态、副作用（聚焦 / 清理定时器）与渲染。
//
// 函数组件范式：查询 / 选中项各一个 useState；模型经 useMemo 随命令集重建；
// 「打开即重置 + 下一帧聚焦」由依赖 open 的 effect 承接（原实现需 componentDidUpdate
// 比对 prev.open）；聚焦定时器在清理函数里销毁（H3 对称）。
//
// 2026-10-19 视觉重构（「纸与墨」体系内）：
// - 输入从「一整块带默认焦点环的裸 input」改成**搜索头**（镜片图标 + 无环输入 + Esc/清除）；
// - 每行加一枚线性图标（`models/Icon.ts`，currentColor，选中时随文字一起变墨色）；
// - 组标题用「小字 + 发丝线」分开，右侧只保留真实快捷键的键帽；
// - 键盘说明从 placeholder 挪到页脚，搜索槽只回答「这里能搜什么」；
// - 补上 combobox / listbox / aria-activedescendant 与选中项自动滚入视野。

import * as React from 'react';
import { Modal } from 'antd';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CommandPaletteModel } from '../models/CommandPaletteModel.ts';
import type { CommandItem } from '../models/CommandPaletteModel.ts';
import { icon } from '../models/Icon.ts';
import type { IconName } from '../models/Icon.ts';
import { t } from '../i18n/i18n.ts';

export type { CommandItem };

/** 命令面板组件的入参。 */
export interface CommandPaletteProps {
  /** 是否打开（关闭时返回 null，不渲染任何节点）。 */
  open: boolean;
  /** 可执行的命令清单。 */
  commands: CommandItem[];
  /** 关闭面板的回调。 */
  onClose: () => void;
}

/**
 * 按命令 id 取图标；未知命令按分组兜底，最后回落 `command`。
 *
 * 图标不写进 `CommandItem`：命令集是控制器构造的纯数据，图标属于「怎么画」，
 * 留在渲染层可以避免每个调用方都重复填一遍。
 */
const ITEM_ICONS: Readonly<Record<string, IconName>> = {
  'pane-tools': 'wrench',
  'pane-metrics': 'chart',
  'pane-plugins': 'plug',
  'pane-graph': 'workflow',
  'pane-memory': 'brain',
  'pane-profiles': 'layers',
  'pane-detail': 'scan',
  'pane-changes': 'diff',
  'pane-rollback': 'rewind',
  'pane-file': 'folder',
  'new-session': 'plus',
  'reload-sessions': 'refresh',
  'open-settings': 'gear',
  'toggle-theme': 'contrast',
  'toggle-left': 'panel-left',
  'toggle-right': 'panel-right',
};

/** 分组兜底图标（命令 id 不在表里时用）。 */
const GROUP_ICONS: Readonly<Record<string, IconName>> = {
  面板: 'command',
  会话: 'message',
  界面: 'sliders',
  其他: 'command',
};

/**
 * 取一条命令的图标名。
 * @param item 命令项
 * @returns 图标名
 */
function iconFor(item: CommandItem): IconName {
  return ITEM_ICONS[item.id] ?? GROUP_ICONS[item.group ?? ''] ?? 'command';
}

/**
 * 把查询命中的片段包成 `<mark>`（只标第一处，避免长命令被刷成斑马线）。
 * @param text 展示文案（已翻译）
 * @param query 当前查询
 * @returns 文本节点或「文本 + mark + 文本」数组
 */
function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (q.length === 0) return text;
  const at = text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
  if (at < 0) return text;
  return [
    text.slice(0, at),
    <mark key="hit" className="cmdk-mark">
      {text.slice(at, at + q.length)}
    </mark>,
    text.slice(at + q.length),
  ];
}

/**
 * 把快捷键文案拆成键帽：`Ctrl/Cmd+Shift+L` → 三枚 `<kbd>`。
 * @param hint 命令自带的快捷键文案（单一来源：KeyboardShortcuts）
 * @returns 键帽数组
 */
function keysOf(hint: string): React.ReactNode {
  return hint
    .split('+')
    .filter((part) => part.length > 0)
    .map((part, i) => (
      <kbd key={i} className="cmdk-key">
        {part}
      </kbd>
    ));
}

/**
 * 命令面板：键盘可达的命令搜索与执行中心（↑↓ 选择、Enter 执行、Esc 关闭）。
 * @param props 组件入参
 * @returns 面板节点；`open` 为 false 时返回 null
 */
/** 分组结果（与 CommandPaletteModel.grouped 同形）。 */
interface PaletteGroup {
  readonly group: string;
  readonly items: readonly { readonly item: CommandItem; readonly index: number }[];
}

/**
 * 命令面板搜索框。
 * @param props 查询、引用与回调。
 * @returns 搜索区节点。
 */
function CommandSearch(props: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  listId: string;
  helpId: string;
  activeId: string | undefined;
  onInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}): ReactElement {
  return (
    <div className="cmdk-search">
      <span className="cmdk-search-icon" aria-hidden="true">
        {icon('search', { size: 15, strokeWidth: 1.9 })}
      </span>
      <input
        ref={props.inputRef}
        className="cmdk-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={props.listId}
        aria-activedescendant={props.activeId}
        aria-describedby={props.helpId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('搜索命令或面板…')}
        aria-label={t('命令搜索框')}
        value={props.query}
        onChange={props.onInput}
      />
      {props.query.length > 0 ? (
        <button
          type="button"
          className="cmdk-clear"
          aria-label={t('清除搜索')}
          tabIndex={-1}
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          onClick={props.onClear}
        >
          {icon('x', { size: 13, strokeWidth: 2 })}
        </button>
      ) : (
        <kbd className="cmdk-esc" aria-hidden="true">
          Esc
        </kbd>
      )}
    </div>
  );
}

/**
 * 命令结果列表。
 * @param props 分组、选中态与执行回调。
 * @returns 列表节点。
 */
function CommandResults(props: {
  listId: string;
  groups: readonly PaletteGroup[];
  total: number;
  query: string;
  active: number;
  optionId: (index: number) => string;
  onActive: (index: number) => void;
  onRun: (index: number) => void;
}): ReactElement {
  return (
    <div
      id={props.listId}
      className="cmdk-list"
      role={props.total > 0 ? 'listbox' : undefined}
      aria-label={props.total > 0 ? t('命令列表') : undefined}
    >
      {props.total === 0 ? (
        <div className="cmdk-empty" role="status">
          <span className="cmdk-empty-icon" aria-hidden="true">
            {icon('search', { size: 22, strokeWidth: 1.6 })}
          </span>
          <span className="cmdk-empty-title">{t('无匹配命令')}</span>
          <span className="cmdk-empty-hint">{t('换个关键词试试')}</span>
        </div>
      ) : (
        props.groups.map((g) => (
          <div key={g.group} className="cmdk-group" role="group" aria-label={t(g.group)}>
            <div className="cmdk-group-title" aria-hidden="true">
              {t(g.group)}
            </div>
            {g.items.map(({ item, index }) => (
              <div
                key={item.id}
                id={props.optionId(index)}
                role="option"
                aria-selected={index === props.active ? 'true' : 'false'}
                className={'cmdk-item' + (index === props.active ? ' active' : '')}
                onMouseEnter={() => props.onActive(index)}
                onClick={() => props.onRun(index)}
              >
                <span className="cmdk-item-icon" aria-hidden="true">
                  {icon(iconFor(item), { size: 16 })}
                </span>
                <span className="cmdk-label">{highlight(t(item.label), props.query)}</span>
                {item.hint ? (
                  <span className="cmdk-hint" aria-hidden="true">
                    {keysOf(item.hint)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * 面板页脚与读屏说明。
 * @param props 命令数与说明 id。
 * @returns 页脚节点。
 */
function CommandFooter(props: { total: number; helpId: string }): ReactElement {
  return (
    <>
      <div className="cmdk-foot">
        <span className="cmdk-total">{t('{count} 个命令', { count: props.total })}</span>
        <span className="cmdk-legend" aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>{t('选择')}</span>
          <span className="cmdk-sep">·</span>
          <kbd>Enter</kbd>
          <span>{t('执行')}</span>
          <span className="cmdk-sep">·</span>
          <kbd>Esc</kbd>
          <span>{t('关闭')}</span>
        </span>
      </div>
      <p id={props.helpId} className="cmdk-help">
        {t('↑↓ 选择，Enter 执行，Esc 关闭')}
      </p>
    </>
  );
}

/**
 * 命令面板状态：查询、选中、模型与 id。
 * @param commands 命令清单。
 * @param open 是否打开。
 * @returns 状态与派生数据。
 */
function usePaletteState(
  commands: readonly CommandItem[],
  open: boolean,
): {
  query: string;
  setQuery: (value: string) => void;
  active: number;
  setActive: React.Dispatch<React.SetStateAction<number>>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  model: CommandPaletteModel;
  listId: string;
  helpId: string;
  filtered: readonly CommandItem[];
  groups: readonly PaletteGroup[];
  total: number;
  optionId: (index: number) => string;
  activeId: string | undefined;
} {
  const [query, setQuery] = React.useState<string>('');
  const [active, setActive] = React.useState<number>(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const model = React.useMemo<CommandPaletteModel>(() => new CommandPaletteModel(commands), [commands]);
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const listId = 'cmdk-list-' + uid;
  const helpId = listId + '-help';
  React.useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setActive(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    document.getElementById(listId + '-opt-' + active)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId, open]);
  const filtered = model.filter(query);
  const groups = model.grouped(query) as readonly PaletteGroup[];
  const total = filtered.length;
  const optionId = (index: number): string => listId + '-opt-' + index;
  return {
    query,
    setQuery,
    active,
    setActive,
    inputRef,
    model,
    listId,
    helpId,
    filtered,
    groups,
    total,
    optionId,
    activeId: total > 0 ? optionId(active) : undefined,
  };
}

/**
 * 命令面板键盘与输入动作。
 * @param opts 状态与回调。
 * @returns 动作集合。
 */
function usePaletteActions(opts: {
  filtered: readonly CommandItem[];
  model: CommandPaletteModel;
  active: number;
  onClose: () => void;
  setActive: React.Dispatch<React.SetStateAction<number>>;
  setQuery: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}): {
  runAt: (index: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onQueryInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  clearQuery: () => void;
} {
  const { filtered, model, active, onClose, setActive, setQuery, inputRef } = opts;
  const runAt = (index: number): void => {
    const item = filtered[index];
    if (!item) return;
    onClose();
    item.run();
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const count = filtered.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((s) => model.move(s, count, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((s) => model.move(s, count, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };
  const onQueryInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
    setActive(0);
  };
  const clearQuery = (): void => {
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };
  return { runAt, onKeyDown, onQueryInput, clearQuery };
}

/**
 * 命令面板。
 * @param props 开合、命令清单与关闭回调。
 * @returns 面板节点；关闭时为 null。
 */
export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
  const { open, commands, onClose } = props;
  const state = usePaletteState(commands, open);
  const { runAt, onKeyDown, onQueryInput, clearQuery } = usePaletteActions({
    filtered: state.filtered,
    model: state.model,
    active: state.active,
    onClose,
    setActive: state.setActive,
    setQuery: state.setQuery,
    inputRef: state.inputRef,
  });
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  /**
   * 挂载即给 dialog 补名字。
   *
   * antd Modal 不转发 `aria-label`（它只认 title，而我们不要可见标题），且真机上 Modal 的
   * 子节点挂载**晚于**布局 effect（jsdom 是同步挂载，所以测不出来）——因此用 ref 回调在
   * 节点真正进树的那一刻写，而不是在 effect 里猜时机。
   */
  const nameDialog = React.useCallback((node: HTMLDivElement | null): void => {
    rootRef.current = node;
    if (node !== null) {
      node.closest('[role="dialog"]')?.setAttribute('aria-label', t('命令面板'));
    }
  }, []);

  if (!open) return null;
  const { query, active, inputRef, listId, helpId, groups, total, optionId, activeId } = state;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      // Esc 交给自研键盘模型（↑↓/Enter/Esc 是一条链路），Modal 不再重复处理。
      keyboard={false}
      mask={{ closable: true }}
      width={580}
      className="cmdk-modal"
      style={{ top: 'max(10vh, 64px)' }}
      destroyOnHidden
    >
      <div className="cmdk" ref={nameDialog} onKeyDown={onKeyDown}>
        <CommandSearch
          inputRef={inputRef}
          query={query}
          listId={listId}
          helpId={helpId}
          activeId={activeId}
          onInput={onQueryInput}
          onClear={clearQuery}
        />

        <CommandResults
          listId={listId}
          groups={groups as readonly PaletteGroup[]}
          total={total}
          query={query}
          active={active}
          optionId={optionId}
          onActive={state.setActive}
          onRun={runAt}
        />

        <CommandFooter total={total} helpId={helpId} />
      </div>
    </Modal>
  );
}
