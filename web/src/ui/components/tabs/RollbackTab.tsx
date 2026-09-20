// 回滚面板（对标 Codex「回滚到检查点」）：列出当前会话的检查点，支持创建与一键回滚。
// 回滚同时还原对话事件与工作区文件（后端 CheckpointManager + GitWorkspaceSnapshot）。
//
// 时间线（A2）：按天分组 + 相对时间 + 「含文件快照 / 仅对话」徽标 + 最新检查点标记；
// 条目本身是 <button>，天然可 Tab 聚焦，Enter/Space 触发回滚（回滚前仍走 DialogService 确认）。
//
// 函数组件范式：列表 / 加载态 / 错误 / 名称草稿 / 忙态各一个 useState；
// 原 componentDidMount + componentDidUpdate 的「会话切换即重拉」合为一个依赖 sessionId 的 effect。
// 命名与时间戳格式化继续复用 models/checkpoint 的零 React 类；分组/相对时间见 models/CheckpointTimeline。

import { React } from '../../deps.js';
import { useApp } from '../../context.js';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CheckpointNamer } from '../../models/checkpoint.js';
import { CheckpointTimeline } from '../../models/CheckpointTimeline.js';
import type { CheckpointMeta } from '../../models/checkpoint.js';
import type { TimelineDay, TimelineEntry } from '../../models/CheckpointTimeline.js';

export type { CheckpointMeta, TimelineEntry, TimelineDay };

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
 * 渲染单个时间线条目（整条即一个按钮：Tab 可达，Enter/Space 触发回滚）。
 * @param e 时间线条目
 * @param busy 是否正在执行回滚（禁用全部条目，防重复提交）
 * @param onRollback 回滚回调（标签）
 * @returns 条目节点
 */
function renderEntry(
  e: TimelineEntry,
  busy: boolean,
  onRollback: (label: string) => void,
): ReactElement {
  const snap = e.hasSnapshot ? '含文件快照' : '仅对话';
  return (
    <div key={e.meta.label} className={'cp-item' + (e.latest ? ' latest' : '')} role="listitem">
      <button
        className="cp-main"
        disabled={busy}
        aria-current={e.latest ? 'true' : undefined}
        title={'回滚到此检查点（需确认）· ' + e.absolute}
        aria-label={`回滚到检查点 ${e.meta.label}（${e.relative}，${e.eventCount} 个事件，${snap}）`}
        onClick={() => onRollback(e.meta.label)}
      >
        <span className="cp-label">{e.meta.label}</span>
        <span className="cp-meta">
          <span className={'cp-badge ' + (e.hasSnapshot ? 'snap' : 'talk')}>{snap}</span>
          <span className="cp-events">{e.eventCount} 事件</span>
          <span className="cp-time">{e.relative}</span>
          {e.latest ? <span className="cp-latest">当前最新</span> : null}
        </span>
      </button>
    </div>
  );
}

/**
 * 渲染按天分组的时间线（空数组返回 null，由调用方决定空态文案）。
 * @param days 分组数据
 * @param busy 是否正在回滚
 * @param onRollback 回滚回调
 * @returns 时间线节点
 */
function renderTimeline(
  days: readonly TimelineDay[],
  busy: boolean,
  onRollback: (label: string) => void,
): ReactElement | null {
  if (days.length === 0) return null;
  return (
    <div className="cp-timeline" role="list" aria-label="检查点时间线">
      {days.map((d) => (
        <section className="cp-day" key={d.key}>
          <div className="cp-day-head">
            <span className="cp-day-title">{d.title}</span>
            <span className="cp-day-count">{d.items.length} 个</span>
          </div>
          {d.items.map((e) => renderEntry(e, busy, onRollback))}
        </section>
      ))}
    </div>
  );
}

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
      {!loading && list.length > 0
        ? renderTimeline(CheckpointTimeline.build(list, new Date()), busy, (l) => void rollback(l))
        : null}
    </div>
  );
}
