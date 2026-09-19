// 命令面板（对标 Codex / 现代编辑器）：Ctrl+P / Ctrl+K 唤起，键盘可达的命令与导航中心。
//
// 面向对象拆分：
// - `CommandPaletteModel`：搜索过滤与选中边界的纯逻辑，零 React 依赖（可单测）。
// - `CommandPalette`：函数组件，只负责状态、副作用（聚焦 / 清理定时器）与渲染。
//
// 函数组件范式：查询 / 选中项各一个 useState；模型经 useMemo 随命令集重建；
// 「打开即重置 + 下一帧聚焦」由依赖 open 的 effect 承接（原实现需 componentDidUpdate
// 比对 prev.open）；聚焦定时器在清理函数里销毁（H3 对称）。

import { React } from '../deps.js';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CommandPaletteModel } from '../models/CommandPaletteModel.js';
import type { CommandItem } from '../models/CommandPaletteModel.js';

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
 * 命令面板：键盘可达的命令搜索与执行中心（↑↓ 选择、Enter 执行、Esc 关闭）。
 * @param props 组件入参
 * @returns 面板节点；`open` 为 false 时返回 null
 */
export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
  const { open, commands, onClose } = props;
  const [query, setQuery] = React.useState<string>('');
  const [active, setActive] = React.useState<number>(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const model = React.useMemo<CommandPaletteModel>(() => new CommandPaletteModel(commands), [commands]);

  // 打开态（含挂载即打开）重置查询 / 选中项并下一帧聚焦（确保元素已进 DOM）；
  // 关闭或卸载即清定时器，避免关闭后仍抢焦点。
  React.useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setActive(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const filtered = model.filter(query);

  /**
   * 执行第 index 项命令：先关闭面板再执行，避免执行后残留弹层。
   * @param index 扁平下标
   * @returns 无
   */
  const runAt = (index: number): void => {
    const item = filtered[index];
    if (!item) return;
    onClose();
    item.run();
  };

  /**
   * 面板级键盘：Esc 关闭、↑↓ 移动选中、Enter 执行。
   * @param e 键盘事件
   * @returns 无
   */
  const onKeyDown = (e: KeyboardEvent): void => {
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
    }
  };

  /**
   * 查询输入：更新关键字并把选中项归零，避免停留在已被过滤掉的位置。
   * @param e 输入事件
   * @returns 无
   */
  const onQueryInput = (e: Event): void => {
    setQuery((e.target as HTMLInputElement | null)?.value ?? '');
    setActive(0);
  };

  // 按 group 分组渲染；`index` 仍是扁平下标，键盘上下键与执行语义不变。
  const groups = model.grouped(query);

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          placeholder="输入命令或搜索…（↑↓ 选择，Enter 执行，Esc 关闭）"
          aria-label="命令搜索框"
          value={query}
          onInput={onQueryInput}
        />
        <div className="cmdk-list" role="listbox" aria-label="命令列表">
          {groups.reduce((n, g) => n + g.items.length, 0) === 0 ? (
            <div className="cmdk-empty">无匹配命令</div>
          ) : (
            groups.map((g) => (
              <div key={g.group} className="cmdk-group" role="group" aria-label={g.group}>
                <div className="cmdk-group-title" aria-hidden="true">
                  {g.group}
                </div>
                {g.items.map(({ item, index }) => (
                  <div
                    key={item.id}
                    role="option"
                    aria-selected={index === active ? 'true' : 'false'}
                    className={'cmdk-item' + (index === active ? ' active' : '')}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runAt(index)}
                  >
                    <span className="cmdk-label">{item.label}</span>
                    {item.hint ? <span className="cmdk-hint">{item.hint}</span> : null}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
