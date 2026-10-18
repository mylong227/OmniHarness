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
 * 3. **未接线如实说**：`ok:false` ⇒ 显示原因与开启方式（多半是 `OMNIHARNESS_VAULT=0` 把保险库
 *    整个关掉了；serve 默认就接线 `~/.omniharness/vault.key`），**不得**渲染成"保险库为空"
 *    （那会被读成"我的凭据丢了"）。
 *
 * @returns 保险库面板节点
 */
// 标准 React 项目写法：`import * as React from 'react'`（Vite 解析裸标识符）。
import * as React from 'react';
import { useApp } from '../../context.ts';
import type { ReactElement } from 'react';
import type { VaultListResult } from '../../../types/models.ts';
import { t } from '../../i18n/i18n.ts';

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
      setNotice(t('已写入 {name}（服务端不回读，值不会在界面上出现）', { name: result.name }));
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
        setNotice(result.removed === true ? t('已删除 {name}', { name: target }) : t('{name} 本来就不存在', { name: target }));
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [api, refresh],
  );

  if (loading) return <div className="vault-tab">{t('载入凭据列表…')}</div>;

  return (
    <div className="vault-tab">
      <div className="detail-section">
        <div className="detail-h">{t('凭据保险库')}</div>
        <p className="hint">
          {t('只列出名字：服务端不提供读回值的接口（凭据写入后仅供运行时取用）。')}
        </p>
        {error !== null ? <p className="err">{error}</p> : null}
        {notice !== null ? <p className="ok">{notice}</p> : null}
        {data !== null && !data.ok ? (
          // 未接线必须直说 + 给出开启方式（不得渲染成"保险库为空"）。
          // 默认口径下 serve 本身就接线（用户级密钥文件 ~/.omniharness/vault.key），
          // 所以这里最常见的原因是 OMNIHARNESS_VAULT=0 被显式关闭。
          <p className="err">
            {t('未接线：{reason}（若设过 OMNIHARNESS_VAULT=0，去掉它后重启 serve；密钥默认来自 ~/.omniharness/vault.key）', { reason: data.reason })}
          </p>
        ) : data !== null && data.ok ? (
          data.names.length === 0 ? (
            <p className="hint">{t('保险库为空（已接线，尚无凭据）。')}</p>
          ) : (
            <ul className="vault-list">
              {data.names.map((item) => (
                <li key={item}>
                  <span>{item}</span>
                  <button type="button" className="btn ghost" onClick={() => void remove(item)}>
                    {t('删除')}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="hint">{t('暂无数据。')}</p>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-h">{t('写入 / 覆盖')}</div>
        <label className="field">
          <span>{t('名称')}</span>
          <input
            type="text"
            value={name}
            placeholder={t('如 OPENAI_API_KEY')}
            autoComplete="off"
            onChange={(e: { target: { value: string } }) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('凭据')}</span>
          <input
            type="password"
            value={secret}
            placeholder={t('粘贴凭据值')}
            autoComplete="new-password"
            onChange={(e: { target: { value: string } }) => setSecret(e.target.value)}
          />
        </label>
        <div className="pane-actions">
          <span className="panel-note" style={{ margin: 0 }}>
            {t('写入后即清空，不会回显')}
          </span>
          <button
            type="button"
            className="btn primary"
            disabled={name.trim() === '' || secret === ''}
            onClick={() => void save()}
          >
            {t('写入')}
          </button>
        </div>
      </div>
    </div>
  );
}
