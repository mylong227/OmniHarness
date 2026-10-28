// 回滚面板：列出当前会话的检查点，支持创建与一键回滚。
// 回滚同时还原对话事件与工作区文件（后端 CheckpointManager + GitWorkspaceSnapshot）。
//
// 时间线（A2）：按天分组 + 相对时间 + 「含文件快照 / 仅对话」徽标 + 最新检查点标记；
// 条目本身是 <button>，天然可 Tab 聚焦，Enter/Space 触发回滚（回滚前仍走 DialogService 确认）。
//
// 函数组件范式：列表 / 加载态 / 错误 / 名称草稿 / 忙态各一个 useState；
// 原 componentDidMount + componentDidUpdate 的「会话切换即重拉」合为一个依赖 sessionId 的 effect。
// 命名与时间戳格式化继续复用 models/checkpoint 的零 React 类；分组/相对时间见 models/CheckpointTimeline。

import * as React from 'react';
import { useApp } from '../../context.ts';
// 领域模型下沉到 models/（零 React 依赖，可单测）；此处 re-export 保持调用方 import 路径不变。
import { CheckpointNamer } from '../../models/checkpoint.ts';
import { CheckpointTimeline } from '../../models/CheckpointTimeline.ts';
import { icon } from '../../models/Icon.ts';
import { emptyNote, emptyState } from '../../format.ts';
import type { CheckpointMeta } from '../../models/checkpoint.ts';
import type { TimelineDay, TimelineEntry } from '../../models/CheckpointTimeline.ts';
import { t } from '../../i18n/i18n.ts';

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
  const snap = e.hasSnapshot ? t('含文件快照') : t('仅对话');
  return (
    <div key={e.meta.label} className={'cp-item' + (e.latest ? ' latest' : '')} role="listitem">
      <button
        className="cp-main"
        disabled={busy}
        aria-current={e.latest ? 'true' : undefined}
        title={t('回滚到此检查点（需确认）· {time}', { time: e.absolute })}
        aria-label={t('回滚到检查点 {label}（{time}，{count} 个事件，{snap}）', {
          label: e.meta.label,
          time: e.relative,
          count: e.eventCount,
          snap,
        })}
        onClick={() => onRollback(e.meta.label)}
      >
        <span className="cp-label">{e.meta.label}</span>
        <span className="cp-meta">
          <span className={'cp-badge ' + (e.hasSnapshot ? 'snap' : 'talk')}>{snap}</span>
          <span className="cp-events">{t('{count} 事件', { count: e.eventCount })}</span>
          <span className="cp-time">{e.relative}</span>
          {e.latest ? <span className="cp-latest">{t('当前最新')}</span> : null}
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
    <div className="cp-timeline" role="list" aria-label={t('检查点时间线')}>
      {days.map((d) => (
        <section className="cp-day" key={d.key}>
          <div className="cp-day-head">
            <span className="cp-day-title">{d.title}</span>
            <span className="cp-day-count">{t('{count} 个', { count: d.items.length })}</span>
          </div>
          {d.items.map((e) => renderEntry(e, busy, onRollback))}
        </section>
      ))}
    </div>
  );
}

/**
 * 回滚面板顶部操作（名称 + 创建 + 刷新）。
 * @param props 名称、忙碌态与回调。
 * @returns 操作区节点。
 */
function RollbackForm(props: {
  label: string;
  busy: boolean;
  onLabel: (value: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="file-actions">
      <input
        className="cmdk-input"
        style={INPUT_STYLE}
        placeholder={t('检查点名称（留空自动生成）')}
        aria-label={t('检查点名称')}
        value={props.label}
        onInput={(e: React.SyntheticEvent) => props.onLabel((e.target as HTMLInputElement).value)}
      />
      <button className="btn primary" disabled={props.busy} onClick={props.onCreate}>
        {t('⎘ 创建检查点')}
      </button>
      <button className="btn" onClick={props.onRefresh}>
        {t('↻ 刷新')}
      </button>
    </div>
  );
}

/**
 * 检查点列表 / 空态 / 错误态。
 * @param props 列表、加载/错误状态与回滚回调。
 * @returns 列表节点。
 */
function RollbackList(props: {
  list: CheckpointMeta[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  onRollback: (label: string) => void;
}): ReactElement {
  if (props.loading) return <>{emptyNote(t('读取中…'), { icon: 'rewind' })}</>;
  if (props.error !== null) {
    return (
      <>
        {emptyNote(t('检查点读取失败：{msg}', { msg: props.error }), {
          kind: 'err',
          icon: 'alert',
        })}
      </>
    );
  }
  if (props.list.length === 0) {
    return (
      <>
        {emptyState(
          icon('rewind', { size: 20 }),
          t('还没有检查点'),
          t('点「创建检查点」先存一个安全网，之后可一键回滚对话与代码。'),
        )}
      </>
    );
  }
  return <>{renderTimeline(CheckpointTimeline.build(props.list, new Date()), props.busy, props.onRollback)}</>;
}

/**
 * 回滚面板：检查点列表 + 创建 + 一键回滚。
 * @param props 组件入参
 * @returns 回滚面板节点（无会话时为引导文案）
 */
export function RollbackTab(props: RollbackTabProps): ReactElement {
  const { sessionId, onRolledBack } = props;
  const { api, toast, dialog, sessionTick } = useApp();
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
  }, [sessionId, sessionTick]);

  /** 创建检查点：名称为空则由 CheckpointNamer 生成，建完刷新列表。 */
  const create = async (): Promise<void> => {
    if (!sessionId) return;
    const name = CheckpointNamer.resolve(label);
    setBusy(true);
    try {
      const r = await api.createCheckpoint(sessionId, name);
      toast(t('已创建检查点：{label}', { label: r.checkpoint.label }), 'ok');
      setLabel('');
      await refresh(sessionId);
    } catch (e) {
      toast(t('创建检查点失败：{msg}', { msg: (e as Error).message }), 'err');
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
      ? t('确认回滚到检查点「{label}」？对话与文件将还原到该点。', { label: target })
      : t('确认回滚到最近的检查点？');
    const ok = await dialog.confirm(msg, {
      title: t('回滚检查点'),
      confirmLabel: t('回滚'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.rollbackCheckpoint(sessionId, target);
      toast(t('已回滚到：{label}', { label: r.checkpoint.label }), 'ok');
      onRolledBack(sessionId);
      await refresh(sessionId);
    } catch (e) {
      toast(t('回滚失败：{msg}', { msg: (e as Error).message }), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId) {
    return (
      emptyState(
        icon('rewind', { size: 20 }),
        t('先选择一个会话'),
        t('回滚是按会话打的检查点：从左侧选一个会话，再创建或回滚到检查点。'),
      )
    );
  }

  return (
    <div className="review">
      <RollbackForm
        label={label}
        busy={busy}
        onLabel={setLabel}
        onCreate={() => void create()}
        onRefresh={() => void refresh(sessionId)}
      />
      <RollbackList
        list={list}
        loading={loading}
        error={error}
        busy={busy}
        onRollback={(target) => void rollback(target)}
      />
    </div>
  );
}
