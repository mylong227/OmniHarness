// 变更面板（git 式）：拉取 changes.list 展示当前工作区文件变更清单（状态 + 增删行数），
// 点击文件查看 patch。git 仓库用真实 git status/diff；非 git 工作区回退聚合本进程 turn_diff 事件。

import { html, React } from '../../deps.js';
import { useApp } from '../../context.js';
import { diffView } from '../../format.js';

/** 单文件变更行。 */
interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** 变更清单响应。 */
interface ChangesData {
  source: string;
  branch?: string;
  files?: ChangeFile[];
}

/** 状态徽章（中文 + 语义色）。 */
function statusBadge(st: string): { label: string; cls: string } {
  if (st === '??' || st === 'A') return { label: '新增', cls: 'add' };
  if (st === 'D') return { label: '删除', cls: 'del' };
  if (st === 'R') return { label: '重命名', cls: 'ren' };
  return { label: '修改', cls: 'mod' };
}

export function ChangesTab(): ReactElement {
  const { api } = useApp();
  const [data, setData] = React.useState<ChangesData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  /** 展开的文件路径（点击查看 patch）。 */
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [patch, setPatch] = React.useState<string>('');
  const [patchLoading, setPatchLoading] = React.useState(false);

  const refresh = React.useCallback(() => {
    setLoaded(false);
    setError(null);
    api
      .listChanges()
      .then((r) => {
        setData(r);
        setLoaded(true);
      })
      .catch((e) => {
        setError((e as Error).message);
        setLoaded(true);
      });
  }, [api]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const openPatch = React.useCallback(
    async (path: string) => {
      if (expanded === path) {
        setExpanded(null);
        setPatch('');
        return;
      }
      setExpanded(path);
      setPatchLoading(true);
      setPatch('');
      try {
        const r = await api.listChanges(path);
        setPatch(r.patch ?? '');
      } catch (e) {
        setPatch('读取失败：' + (e as Error).message);
      } finally {
        setPatchLoading(false);
      }
    },
    [api, expanded],
  );

  if (!loaded && data === null) return html`<div className="empty">读取中…</div>`;
  if (error !== null)
    return html`<div className="empty">
      变更读取失败：${error}
      <div style=${{ marginTop: '10px' }}><button className="btn" onClick=${refresh}>重试</button></div>
    </div>`;

  const files = data?.files ?? [];
  const isGit = data?.source === 'git';

  return html`<div>
    <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
      <span style=${{ fontSize: '12px', color: 'var(--dim)' }}>
        ${isGit ? `Git 工作区${data?.branch ? ' · ' + data.branch : ''}` : '本会话产生的变更（非 git 工作区）'}
      </span>
      <button className="btn" onClick=${refresh}>↻ 刷新</button>
    </div>
    ${files.length === 0
      ? html`<div className="empty">✨ 没有变更——工作区很干净。改点东西再来看。</div>`
      : html`<div className="changes-list">
          ${files.map((f) => {
            const badge = statusBadge(f.status);
            const open = expanded === f.path;
            return html`<div key=${f.path} className="change-item">
              <div className="change-row" onClick=${() => void openPatch(f.path)} title="点击查看变更内容">
                <span className=${'change-badge ' + badge.cls}>${badge.label}</span>
                <span className="change-path">${f.path}</span>
                <span className="change-nums">
                  ${f.additions > 0 ? html`<span className="additions">+${f.additions}</span>` : null}
                  ${f.deletions > 0 ? html`<span className="deletions">−${f.deletions}</span>` : null}
                </span>
                <span className="change-caret">${open ? '▾' : '▸'}</span>
              </div>
              ${open
                ? html`<div className="change-patch">
                    ${patchLoading ? html`<div className="empty">读取中…</div>` : patch === '' ? html`<div className="empty">无 diff 内容（可能是二进制文件或模式变更）</div>` : diffView(patch)}
                  </div>`
                : null}
            </div>`;
          })}
        </div>`}
  </div>`;
}
