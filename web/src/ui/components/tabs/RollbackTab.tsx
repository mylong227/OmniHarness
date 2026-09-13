// 回滚面板（对标 Codex「回滚到检查点」）：列出当前会话的检查点，支持创建与一键回滚。
// 回滚同时还原对话事件与工作区文件（后端 CheckpointManager + GitWorkspaceSnapshot）。
//
// 面向对象：组件继承 AppComponent（拿 api / toast），命名与时间戳格式化抽为可单测的类/静态方法。

import { React } from '../../deps.js';
import { AppComponent } from '../../base/AppComponent.js';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CheckpointNamer, TimestampFormatter } from '../../models/checkpoint.js';
import type { CheckpointMeta } from '../../models/checkpoint.js';

export type { CheckpointMeta };

export interface RollbackTabProps {
  sessionId: string | null;
  /** 回滚成功后回调（App 重新加载会话）。 */
  onRolledBack: (sessionId: string) => void;
}

interface RollbackTabState {
  list: CheckpointMeta[];
  loading: boolean;
  error: string | null;
  label: string;
  busy: boolean;
}

/** 回滚面板组件（class 组件）：检查点列表 + 创建 + 回滚。 */
export class RollbackTab extends AppComponent<RollbackTabProps, RollbackTabState> {
  constructor(props: RollbackTabProps) {
    super(props);
    this.state = { list: [], loading: false, error: null, label: '', busy: false };
    this.onLabelInput = this.onLabelInput.bind(this);
    this.onCreate = this.onCreate.bind(this);
    this.onRefreshClick = this.onRefreshClick.bind(this);
  }

  override componentDidMount(): void {
    void this.refresh();
  }

  /** 会话切换时重新拉取检查点（等价于原 useEffect 依赖 sessionId）。 */
  override componentDidUpdate(prev: RollbackTabProps): void {
    if (prev.sessionId !== this.props.sessionId) void this.refresh();
  }

  /** 拉取检查点列表；无会话时清空（fail-closed 到空态）。 */
  private async refresh(): Promise<void> {
    const { sessionId } = this.props;
    if (!sessionId) {
      this.setState({ list: [], error: null });
      return;
    }
    this.setState({ loading: true, error: null });
    try {
      const r = await this.api.listCheckpoints(sessionId);
      this.setState({ list: r.checkpoints ?? [], loading: false });
    } catch (e) {
      this.setState({ error: (e as Error).message, loading: false });
    }
  }

  private async create(): Promise<void> {
    const { sessionId } = this.props;
    if (!sessionId) return;
    const name = CheckpointNamer.resolve(this.state.label);
    this.setState({ busy: true });
    try {
      const r = await this.api.createCheckpoint(sessionId, name);
      this.toast(`已创建检查点：${r.checkpoint.label}`, 'ok');
      this.setState({ label: '' });
      await this.refresh();
    } catch (e) {
      this.toast('创建检查点失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: false });
    }
  }

  private async rollback(target?: string): Promise<void> {
    const { sessionId, onRolledBack } = this.props;
    if (!sessionId) return;
    const msg = target
      ? `确认回滚到检查点「${target}」？对话与文件将还原到该点。`
      : '确认回滚到最近的检查点？';
    const ok = await this.dialog.confirm(msg, {
      title: '回滚检查点',
      confirmLabel: '回滚',
      danger: true,
    });
    if (!ok) return;
    this.setState({ busy: true });
    try {
      const r = await this.api.rollbackCheckpoint(sessionId, target);
      this.toast(`已回滚到：${r.checkpoint.label}`, 'ok');
      onRolledBack(sessionId);
      await this.refresh();
    } catch (e) {
      this.toast('回滚失败：' + (e as Error).message, 'err');
    } finally {
      this.setState({ busy: false });
    }
  }

  private onLabelInput(e: Event): void {
    this.setState({ label: (e.target as HTMLInputElement | null)?.value ?? '' });
  }

  private onCreate(): void {
    void this.create();
  }

  private onRefreshClick(): void {
    void this.refresh();
  }

  override render(): ReactElement {
    const { sessionId } = this.props;
    const { list, loading, error, label, busy } = this.state;

    if (!sessionId) {
      return (
        <div className="empty">
          ⌹ 回滚面板 · 先选择一个会话（左侧）再操作。没有会话时无从打点或回滚。
        </div>
      );
    }

    const inputStyle: Record<string, string> = {
      flex: '1 1 200px',
      padding: '7px 10px',
      borderRadius: '6px',
      border: '1px solid var(--border)',
      background: 'transparent',
      color: 'inherit',
    };

    return (
      <div className="review">
        <div className="file-actions">
          <input
            className="cmdk-input"
            style={inputStyle}
            placeholder="检查点名称（留空自动生成）"
            aria-label="检查点名称"
            value={label}
            onInput={this.onLabelInput}
          />
          <button className="btn primary" disabled={busy} onClick={this.onCreate}>
            ⎘ 创建检查点
          </button>
          <button className="btn" onClick={this.onRefreshClick}>
            ↻ 刷新
          </button>
        </div>
        {loading ? <div className="empty">读取中…</div> : null}
        {error !== null ? <div className="empty">检查点读取失败：{error}</div> : null}
        {!loading && error === null && list.length === 0 ? (
          <div className="empty">
            ✨ 暂无检查点。点「创建检查点」先存一个安全网，之后可一键回滚对话与代码。
          </div>
        ) : null}
        {!loading && list.length > 0 ? (
          <div className="changes-list">
            {[...list].reverse().map((c) => (
              <div key={c.label} className="change-item">
                <div className="change-row" style={{ cursor: 'default' }}>
                  <span className={'change-badge ' + (c.hasFileSnapshot ? 'mod' : 'add')}>
                    {c.hasFileSnapshot ? '含文件' : '仅对话'}
                  </span>
                  <span className="change-path">{c.label}</span>
                  <span className="change-nums">{c.eventCount} 事件</span>
                  <span className="change-caret">{TimestampFormatter.format(c.ts)}</span>
                </div>
                <div className="change-patch" style={{ padding: '8px 10px' }}>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void this.rollback(c.label)}
                  >
                    ↩ 回滚到此点
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
}
