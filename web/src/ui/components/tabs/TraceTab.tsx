/**
 * Trace 自省面板（Web 交付项，2026-10-11）：把 `trace.read` 的**冻结条目快照**渲染出来。
 *
 * ## 这一屏回答什么
 *
 * 「这个会话**实际发生过什么**」——条目来自服务端只读投影（`ReadOnlyTraceReader` 深拷贝 +
 * `Object.freeze`，无写方法，agent 无法借道篡改历史）。面板只做两件事：按量/类别取，
 * 然后**原样**列出 `seq / 时刻 / 类别 / 摘要`。
 *
 * ## 三条纪律
 *
 * 1. **会话不存在必须直说**：`result.error` 非空 ⇒ 显示原因（"会话不存在"与"该会话没有事件"
 *    在服务端被刻意区分开，面板不得把它们都渲染成空列表）；
 * 2. **空结果要说明是"查询无匹配"**：`error` 为空且 `count===0` ⇒ 明确写成"本次查询无匹配条目"；
 * 3. **过滤条件照实回显**：类别/条数上限生效时显示出来，避免"只看到 5 条"被读成"总共 5 条"。
 *
 * @returns trace 面板节点
 */
// 零打包器：React 由 deps.js 从 UMD 全局取（不得 import 裸标识符 'react'）。
import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import { timeOf } from '../../format.js';
import type { ReactElement } from 'react';
import type { TraceReadResultLike } from '../../../types/models.js';

/** Trace 面板入参。 */
export interface TraceTabProps {
  /** 目标会话 id（缺省空串 ⇒ 面板提示先选会话，不猜）。 */
  readonly sessionId?: string | null | undefined;
}

/** Trace 自省面板：只读条目列表。 */
export function TraceTab(props: TraceTabProps): ReactElement {
  const { api } = useApp();
  const sessionId = props.sessionId ?? '';
  const [data, setData] = React.useState<TraceReadResultLike | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [kindFilter, setKindFilter] = React.useState<string>('');
  const [limit, setLimit] = React.useState<string>('20');

  /** 拉取只读条目（失败也进状态）。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    if (sessionId === '') {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsed = Number.parseInt(limit, 10);
      const r = await api.traceRead({
        session: sessionId,
        ...(kindFilter === '' ? {} : { kind: kindFilter }),
        ...(Number.isFinite(parsed) && parsed > 0 ? { limit: parsed } : {}),
      });
      setData(r);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, sessionId, kindFilter, limit]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (sessionId === '') {
    // 不猜会话：空会话时给出明确指引，而不是拿"最近会话"糊一个结果。
    return <div className="trace-tab">请先选择一个会话（trace 自省按会话读取）。</div>;
  }
  if (loading) return <div className="trace-tab">载入 trace 条目…</div>;
  if (error !== null) {
    return (
      <div className="trace-tab">
        <p className="err">读取 trace 失败：{error}</p>
        <button type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }
  if (data === null) return <div className="trace-tab">暂无 trace 数据。</div>;
  if (data.error !== undefined) {
    // 纪律①：会话不存在 / 存档不可读 ⇒ 直说原因，不显示空列表。
    return (
      <div className="trace-tab">
        <p className="err">{data.error}</p>
        <button type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="trace-tab">
      <div className="detail-section">
        <div className="detail-h">过滤</div>
        <label>
          类别
          <input
            type="text"
            value={kindFilter}
            placeholder="如 tool.call（留空＝全部）"
            onChange={(e: { target: { value: string } }) => setKindFilter(e.target.value)}
          />
        </label>
        <label>
          条数上限
          <input
            type="text"
            value={limit}
            onChange={(e: { target: { value: string } }) => setLimit(e.target.value)}
          />
        </label>
        <button type="button" onClick={() => void refresh()}>
          查询
        </button>
        <span className="hint">
          会话 {data.session} · 本次返回 {data.count} 条
          {kindFilter === '' ? '' : ` · 类别 ${kindFilter}`}
        </span>
      </div>
      {data.entries.length === 0 ? (
        <p className="hint">本次查询无匹配条目（会话存在但该条件下没有条目）。</p>
      ) : (
        <ul>
          {data.entries.map((entry) => (
            <li key={`${String(entry.seq)}-${entry.kind}`}>
              #{entry.seq} · {timeOf(Date.parse(entry.at))} · {entry.kind} · {entry.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
