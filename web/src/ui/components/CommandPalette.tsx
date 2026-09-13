// 命令面板（对标 Codex / 现代编辑器）：Ctrl+P / Ctrl+K 唤起，键盘可达的命令与导航中心。
//
// 面向对象拆分：
// - `CommandPaletteModel`：搜索过滤与选中边界的纯逻辑，零 React 依赖（可单测）。
// - `CommandPalette`：class 组件，只负责状态、生命周期（聚焦/卸载清理）与渲染。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CommandPaletteModel } from '../models/CommandPaletteModel.js';
import type { CommandItem } from '../models/CommandPaletteModel.js';

export type { CommandItem };

export interface CommandPaletteProps {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
}

interface CommandPaletteState {
  query: string;
  active: number;
}

/** 命令面板组件（class 组件）：键盘导航 + 搜索执行。 */
export class CommandPalette extends AppComponent<CommandPaletteProps, CommandPaletteState> {
  private readonly inputRef = React.createRef<HTMLInputElement>();
  private model: CommandPaletteModel;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: CommandPaletteProps) {
    super(props);
    this.state = { query: '', active: 0 };
    this.model = new CommandPaletteModel(props.commands);
    // 事件处理器绑定 this：class 组件方法默认不绑定（与回调式 props 搭配时的经典坑）。
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onBackdropMouseDown = this.onBackdropMouseDown.bind(this);
    this.onDialogMouseDown = this.onDialogMouseDown.bind(this);
    this.onQueryInput = this.onQueryInput.bind(this);
  }

  /** 打开时（含首次挂载即为打开态）重置查询并聚焦输入框。 */
  override componentDidMount(): void {
    if (this.props.open) this.focusInput();
  }

  /** 命令集变化时重建模型；打开态切换时重置状态并聚焦。 */
  override componentDidUpdate(prev: CommandPaletteProps): void {
    if (prev.commands !== this.props.commands) {
      this.model = new CommandPaletteModel(this.props.commands);
    }
    if (this.props.open && !prev.open) {
      this.setState({ query: '', active: 0 });
      this.focusInput();
    }
  }

  override componentWillUnmount(): void {
    this.clearFocusTimer();
  }

  private clearFocusTimer(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
  }

  /** 下一帧聚焦：确保元素已渲染进 DOM。 */
  private focusInput(): void {
    this.clearFocusTimer();
    this.focusTimer = setTimeout(() => this.inputRef.current?.focus(), 0);
  }

  private get filtered(): CommandItem[] {
    return this.model.filter(this.state.query);
  }

  /** 执行第 i 项命令：先关闭面板再执行（避免执行后残留弹层）。 */
  private runAt(index: number): void {
    const item = this.filtered[index];
    if (!item) return;
    this.props.onClose();
    item.run();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const count = this.filtered.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.props.onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.setState((s) => ({ active: this.model.move(s.active, count, 1) }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.setState((s) => ({ active: this.model.move(s.active, count, -1) }));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runAt(this.state.active);
    }
  }

  private onQueryInput(e: Event): void {
    const value = (e.target as HTMLInputElement | null)?.value ?? '';
    // 查询变化后选中项回到 0，避免停留在已被过滤掉的位置。
    this.setState({ query: value, active: 0 });
  }

  private onBackdropMouseDown(): void {
    this.props.onClose();
  }

  private onDialogMouseDown(e: MouseEvent): void {
    // 阻止冒泡到背景层，否则点击面板内部也会关闭。
    e.stopPropagation();
  }

  override render(): ReactElement | null {
    const { open, onClose } = this.props;
    if (!open) return null;
    const { query, active } = this.state;
    const filtered = this.filtered;

    return (
      <div className="cmdk-backdrop" onMouseDown={this.onBackdropMouseDown}>
        <div
          className="cmdk"
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
          onMouseDown={this.onDialogMouseDown}
          onKeyDown={this.onKeyDown}
        >
          <input
            ref={this.inputRef}
            className="cmdk-input"
            type="text"
            placeholder="输入命令或搜索…（↑↓ 选择，Enter 执行，Esc 关闭）"
            aria-label="命令搜索框"
            value={query}
            onInput={this.onQueryInput}
          />
          <div className="cmdk-list" role="listbox" aria-label="命令列表">
            {filtered.length === 0 ? (
              <div className="cmdk-empty">无匹配命令</div>
            ) : (
              filtered.map((c, i) => (
                <div
                  key={c.id}
                  role="option"
                  aria-selected={i === active ? 'true' : 'false'}
                  className={'cmdk-item' + (i === active ? ' active' : '')}
                  onMouseEnter={() => this.setState({ active: i })}
                  onClick={() => this.runAt(i)}
                >
                  <span className="cmdk-label">{c.label}</span>
                  {c.hint ? <span className="cmdk-hint">{c.hint}</span> : null}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }
}
