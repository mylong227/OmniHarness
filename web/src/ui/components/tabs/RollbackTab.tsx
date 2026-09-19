// 回滚面板（对标 Codex「回滚到检查点」）：列出当前会话的检查点，支持创建与一键回滚。
// 回滚同时还原对话事件与工作区文件（后端 CheckpointManager + GitWorkspaceSnapshot）。
//
// 函数组件范式：列表 / 加载态 / 错误 / 名称草稿 / 忙态各一个 useState；
// 原 componentDidMount + componentDidUpdate 的「会话切换即重拉」合为一个依赖 sessionId 的 effect。
// 命名与时间戳格式化继续复用 models/checkpoint 的零 React 类。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CheckpointNamer, TimestampFormatter } from '../../models/checkpoint.js';
import type { CheckpointMeta } from '../../models/checkpoint.js';

export type { CheckpointMeta };

/** RollbackTab 组件的入参。 */
export interface RollbackTabProps {
  /** 当前会话 id；为 null 时提示先选会话。 */
  sessionId: string | null;
  /** 回滚成功后回调（App 重新加载会话）。 */
  onRolledBack: (sessionId: string) => void;
}

/** 检查点名称输入框的行内样式。 */
const INPUT_STYLE: Record<string, string> = {
  flex: '1 1 200px',
  padding: '7px 10px',
  borderRadius: '6px',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
};

/**
 * 回滚面板：检查点列表 + 创建 + 一键回滚。
 * @param props 组件入参
 * @returns 回滚面板节点（无会话时为引导文案）
 */
export function RollbackTab(props: RollbackTabProps): ReactElement {
  const { sessionId, onRolledBack } = props;
  const { api, toast, dialog } = useApp();
  const [list, setList] = React.useState<CheckpointMeta[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState<string>('');
  const [busy, setBusy] = React.useState<boolean>(false);

  /**
   * 拉取检查点列表；无会话时清空（fail-closed 到空态）。
   * @param sid 目标会话 id（显式传参，避免依赖渲染快照）
   */
  const refresh = async (sid: string | null): Promise<void> => {
    if (!sid) {
      setList([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.listCheckpoints(sid);
      setList(r.checkpoints ?? []);
      setLoading(false);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  };

  // 挂载装载 + 会话切换即重拉（deps 只有 sessionId）。
  React.useEffect(() => {
    void refresh(sessionId);
  }, [sessionId]);

  /** 创建检查点：名称为空则由 CheckpointNamer 生成，建完刷新列表。 */
  const create = async (): Promise<void> => {
    if (!sessionId) return;
    const name = CheckpointNamer.resolve(label);
    setBusy(true);
    try {
      const r = await api.createCheckpoint(sessionId, name);
      toast(`已创建检查点：${r.checkpoint.label}`, 'ok');
      setLabel('');
      await refresh(sessionId);
    } catch (e) {
      toast('创建检查点失败：' + (e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 回滚（先经 DialogService 确认，决策不静默产生）。
   * @param target 目标检查点标签；缺省回滚到最近一点
   */
  const rollback = async (target?: string): Promise<void> => {
    if (!sessionId) return;
    const msg = target
      ? `确认回滚到检查点「${target}」？对话与文件将还原到该点。`
      : '确认回滚到最近的检查点？';
    const ok = await dialog.confirm(msg, {
      title: '回滚检查点',
      confirmLabel: '回滚',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.rollbackCheckpoint(sessionId, target);
      toast(`已回滚到：${r.checkpoint.label}`, 'ok');
      onRolledBack(sessionId);
      await refresh(sessionId);
    } catch (e) {
      toast('回滚失败：' + (e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId) {
    return (
      <div className="empty">
        ⌹ 回滚面板 · 先选择一个会话（左侧）再操作。没有会话时无从打点或回滚。
      </div>
    );
  }

  return (
    <div className="review">
      <div className="file-actions">
        <input
          className="cmdk-input"
          style={INPUT_STYLE}
          placeholder="检查点名称（留空自动生成）"
          aria-label="检查点名称"
          value={label}
          onInput={(e: Event) => setLabel((e.target as HTMLInputElement).value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => void create()}>
          ⎘ 创建检查点
        </button>
        <button className="btn" onClick={() => void refresh(sessionId)}>
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
                <button className="btn" disabled={busy} onClick={() => void rollback(c.label)}>
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
