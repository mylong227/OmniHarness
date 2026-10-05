/**
 * 治理台面板（**F2** 的 Web 工作台 tab）：把晋升台账的**逐行独立复核**结果渲染出来。
 *
 * ## 这一屏回答什么
 *
 * 「这条晋升记录**是否可被独立复核**」——每一行显示该行**自己**的复核结论（✓/✗ 与可读原因），
 * 而不是一个笼统的"台账完整"。数据来自 `governance.history`（服务端直接转发
 * `PromotionHistoryService.view()`，判据在数据面已钉死：改正文/删行/改哈希三类都能检出）。
 *
 * ## 三条 UI 纪律
 *
 * 1. **坏行必须显眼**：`verified:false` 的行标红并**直接显示原因**（"第 N 条自算哈希不符"），
 *    而不是让用户自己去找哪一行坏了；
 * 2. **台账读不出来就直说**：服务端 `available:false` ⇒ 显示原因，**不显示空列表**
 *    （空列表会被误读成"没有晋升记录"）；
 * 3. **回滚是显式动作**：本面板只**列出**可回滚快照锚点并提示命令入口；
 *    真正回滚走 `omniharness evolution rollback --seq N --yes`——治理动作不能在 UI 上一点就改历史
 *    （与 `rollback` tab 的会话检查点回滚是两回事：那是会话级，这是**进化台账**级）。
 *
 * @returns 治理面板节点
 */
// 零打包器：React 由 deps.js 从 UMD 全局取（**不得** `import ... from 'react'`——浏览器无法解析该裸标识符，
// 整页会因模块解析失败而完全不挂载；web e2e 正是靠这一条把这类错误挡在提交前）。
import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import type { ReactElement } from 'react';

/** 治理台一行的形状（与服务端 `PromotionHistoryRow` 同形）。 */
interface GovernanceRow {
  readonly seq: number;
  readonly ts: string;
  readonly action: string;
  readonly name?: string;
  readonly source?: string;
  readonly rollbackTo?: number;
  readonly hash: string;
  readonly prev: string;
  readonly verified: boolean;
  readonly reason?: string;
}

/** 服务端 `governance.history` 的返回形状。 */
type GovernanceHistory =
  | {
      readonly available: true;
      readonly view: {
        readonly rows: readonly GovernanceRow[];
        readonly summary: {
          readonly total: number;
          readonly verified: number;
          readonly firstFailureSeq?: number;
        };
        readonly rollbackTargets: readonly {
          readonly seq: number;
          readonly ts: string;
          readonly skillCount: number;
        }[];
      };
    }
  | { readonly available: false; readonly reason: string };

/**
 * 治理面板：晋升台账逐行复核 + 回滚锚点。
 * @returns 治理面板节点
 */
export function GovernanceTab(): ReactElement {
  const { api } = useApp();
  const [data, setData] = React.useState<GovernanceHistory | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);

  /** 拉取治理视图（失败也进状态：UI 必须能显示"读不出来"，不许静默空列表）。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.rpc<GovernanceHistory>('governance.history');
      setData(r);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <div className="governance-tab">载入晋升台账…</div>;
  if (error !== null) {
    return (
      <div className="governance-tab">
        <p className="err">读取治理数据失败：{error}</p>
        <button type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }
  if (data === null) return <div className="governance-tab">暂无治理数据。</div>;
  if (!data.available) {
    // 读不出来要**直说**：空列表会被误读成"没有晋升记录"。
    return (
      <div className="governance-tab">
        <p className="err">{data.reason}</p>
        <p className="hint">台账尚未产生时可忽略；若已产生过晋升，请检查工作区 .omniharness/evolution。</p>
        <button type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  const { rows, summary, rollbackTargets } = data.view;
  return (
    <div className="governance-tab">
      <header className="row">
        <strong>进化治理</strong>
        <span className={summary.verified === summary.total ? 'ok' : 'err'}>
          独立复核通过 {summary.verified} / {summary.total}
          {summary.firstFailureSeq === undefined ? '' : `（首个失败 #${summary.firstFailureSeq}）`}
        </span>
        <button type="button" onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      {rows.length === 0 ? (
        <p className="hint">台账为空：还没有晋升记录（进化默认关，属预期状态）。</p>
      ) : (
        <ul className="governance-rows">
          {rows.map((row) => (
            <li key={row.seq} className={row.verified ? 'row' : 'row err'}>
              <span className="seq">#{row.seq}</span>
              <span className="action">{row.action}</span>
              {row.name === undefined ? null : (
                <span className="name">
                  {row.name}
                  {row.source === undefined ? '' : ` ← ${row.source}`}
                </span>
              )}
              <span className={row.verified ? 'ok' : 'err'}>{row.verified ? '✓' : '✗'}</span>
              {row.reason === undefined ? null : <span className="reason">{row.reason}</span>}
              <span className="hash" title={`prev ${row.prev}`}>
                {row.hash.slice(0, 12)}…
              </span>
            </li>
          ))}
        </ul>
      )}
      <section className="rollback-targets">
        <strong>可回滚快照</strong>
        {rollbackTargets.length === 0 ? (
          <p className="hint">（无）</p>
        ) : (
          <ul>
            {rollbackTargets.map((target) => (
              <li key={target.seq}>
                #{target.seq}（{target.skillCount} 技能，{target.ts}）
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          回滚是治理动作，需显式确认：`omniharness evolution rollback --seq &lt;N&gt; --yes`
        </p>
      </section>
    </div>
  );
}

