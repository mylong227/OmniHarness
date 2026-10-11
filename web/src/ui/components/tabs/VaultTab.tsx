/**
 * 凭据保险库面板（Web 交付第 6 个入口，2026-10-11）：列出凭据名、写入/覆盖、删除。
 *
 * ## 为什么这一屏**故意**看不到凭据值
 *
 * 服务端**没有** `vault.get`（见 `vaultRpc.test.ts` 判据③）。理由是用途：面板要的是"管理 agent 用的
 * 凭据"——列出名字、写入、删除；把密文读回浏览器页面没有任何必要用途，只会多一条泄露面
 * （HTTP 响应、前端状态、DevTools、日志）。故本面板：
 *
 * 1. **只渲染名字**：数据来自 `vault.list`（契约就是"只回名字"），面板里不存在"取回值"的路径；
 * 2. **输入框是单向的**：写入成功后**立即清空**密码输入框（既不回显也不保留在组件状态里）；
 * 3. **未接线如实说**：`ok:false` ⇒ 显示原因与开启方式（设 `OMNIHARNESS_VAULT_KEY` 或
 *    `--vault-key-file`），**不得**渲染成"保险库为空"（那会被读成"我的凭据丢了"）。
 *
 * @returns 保险库面板节点
 */
// 零打包器：React 由 deps.js 从 UMD 全局取（不得 import 裸标识符 'react'）。
import { React } from '../../deps.js';
import { useApp } from '../../context.js';
import type { ReactElement } from 'react';
import type { VaultListResult } from '../../../types/models.js';

/** 保险库面板。 */
export function VaultTab(): ReactElement {
  const { api } = useApp();
  const [data, setData] = React.useState<VaultListResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [name, setName] = React.useState<string>('');
  const [secret, setSecret] = React.useState<string>('');

  /** 拉取凭据名列表。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.vaultList());
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

  /** 写入（或覆盖）一项；成功后清空两个输入（不保留密文）。 */
  const save = React.useCallback(async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      const result = await api.vaultSet(name, secret);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setName('');
      setSecret('');
      setNotice(`已写入 ${result.name}（服务端不回读，值不会在界面上出现）`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, name, secret, refresh]);

  /** 删除一项。 */
  const remove = React.useCallback(
    async (target: string): Promise<void> => {
      setError(null);
      setNotice(null);
      try {
        const result = await api.vaultDelete(target);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setNotice(result.removed === true ? `已删除 ${target}` : `${target} 本来就不存在`);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [api, refresh],
  );

  if (loading) return <div className="vault-tab">载入凭据列表…</div>;

  return (
    <div className="vault-tab">
      <div className="detail-section">
        <div className="detail-h">凭据保险库</div>
        <p className="hint">
          只列出**名字**：服务端不提供读回值的接口（凭据写入后仅供运行时取用）。
        </p>
        {error !== null ? <p className="err">{error}</p> : null}
        {notice !== null ? <p className="ok">{notice}</p> : null}
        {data !== null && !data.ok ? (
          // 未接线必须直说 + 给出开启方式（不得渲染成"保险库为空"）。
          <p className="err">
            未接线：{data.reason}（设 OMNIHARNESS_VAULT_KEY 或 --vault-key-file 后重启 serve）
          </p>
        ) : data !== null && data.ok ? (
          data.names.length === 0 ? (
            <p className="hint">保险库为空（已接线，尚无凭据）。</p>
          ) : (
            <ul>
              {data.names.map((item) => (
                <li key={item}>
                  <span>{item}</span>
                  <button type="button" onClick={() => void remove(item)}>
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="hint">暂无数据。</p>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-h">写入 / 覆盖</div>
        <label>
          名称
          <input
            type="text"
            value={name}
            placeholder="如 OPENAI_API_KEY"
            onChange={(e: { target: { value: string } }) => setName(e.target.value)}
          />
        </label>
        <label>
          凭据
          <input
            type="password"
            value={secret}
            placeholder="写入后即清空，不会回显"
            onChange={(e: { target: { value: string } }) => setSecret(e.target.value)}
          />
        </label>
        <button type="button" disabled={name.trim() === '' || secret === ''} onClick={() => void save()}>
          写入
        </button>
      </div>
    </div>
  );
}
