// 文件夹选择器（+ 添加项目）：服务端 fs.browse 驱动的目录浏览器。
// 浏览器沙箱拿不到本机绝对路径，window.prompt 手输已被否——由本地服务端列目录、
// UI 内嵌选择，选中即得真实绝对路径。

import { html, React } from '../deps.js';
import type { ApiClient } from '../../core/ApiClient.js';

type BrowseResult =
  | { level: 'drives'; roots: string[]; home: string }
  | { level: 'dir'; path: string; parent?: string; dirs: string[] };

export interface FolderPickerProps {
  api: ApiClient;
  onCancel: () => void;
  /** 确认选择：传入选中目录的绝对路径。 */
  onPick: (path: string) => void;
}

export function FolderPicker(props: FolderPickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const [cur, setCur] = React.useState<string | null>(null);
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [parent, setParent] = React.useState<string | undefined>(undefined);
  const [roots, setRoots] = React.useState<string[]>([]);
  const [home, setHome] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  /** 新建文件夹模式：true 时在列表上方显示名称输入框。 */
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [creatingErr, setCreatingErr] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const r: BrowseResult = await api.browseFs(path);
        if (r.level === 'drives') {
          setRoots(r.roots);
          setHome(r.home);
          setCur(null);
          setDirs([]);
          setParent(undefined);
        } else {
          setCur(r.path);
          setDirs(r.dirs);
          setParent(r.parent);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  const escHandler = React.useCallback(
    (e: KeyboardEvent) => {
      if (creating) {
        setCreating(false);
        setCreatingErr(null);
        return;
      }
      if (e.key === 'Escape') onCancel();
    },
    [creating, onCancel],
  );
  React.useEffect(() => {
    window.addEventListener('keydown', escHandler);
    return () => window.removeEventListener('keydown', escHandler);
  }, [escHandler]);

  /** 确认：盘符层禁用（必须进到具体目录），目录层返回当前路径。 */
  const confirm = () => {
    if (cur !== null) onPick(cur);
  };

  /** 新建文件夹：在当前目录内创建子目录，建完即作为项目返回（会话归属它管理）。 */
  const createFolder = React.useCallback(async () => {
    if (cur === null) return;
    const name = newName.trim();
    if (name === '') {
      setCreatingErr('请输入文件夹名称');
      return;
    }
    setCreatingErr(null);
    try {
      const r = await api.mkdirFs(cur, name);
      setCreating(false);
      setNewName('');
      // 建完直接选回：SessionPanel 会 addWorkspace + switchWorkspace，会话归它管。
      onPick(r.path);
    } catch (e) {
      setCreatingErr((e as Error).message);
    }
  }, [api, cur, newName, onPick]);

  return html`<div className="fp-overlay" onClick=${onCancel}>
    <div className="fp-modal" onClick=${(e: MouseEvent) => e.stopPropagation()}>
      <div className="fp-head">
        <span className="fp-title">选择项目文件夹</span>
        <button className="fp-close" title="关闭 (Esc)" onClick=${onCancel}>✕</button>
      </div>

      <div className="fp-pathbar">
        ${cur === null
          ? html`<span className="fp-crumb">此电脑（选择盘符）</span>`
          : html`<span className="fp-crumb" title=${cur}>${cur}</span>`}
        <button
          className="fp-new"
          title="在当前目录内新建项目文件夹"
          disabled=${cur === null || loading}
          onClick=${() => {
            setCreating(true);
            setCreatingErr(null);
            setNewName('新项目');
          }}
        >📂 新建文件夹</button>
      </div>

      <div className="fp-list">
        ${creating
          ? html`<div className="fp-create">
              <span className="fp-create-label">在 ${cur ?? ''} 内新建：</span>
              <div className="fp-create-row">
                <input
                  className="fp-input"
                  value=${newName}
                  placeholder="文件夹名称"
                  onInput=${(e: InputEvent) => setNewName((e.target as HTMLInputElement).value)}
                  onKeyDown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') void createFolder();
                  }}
                />
                <button className="fp-btn fp-primary" onClick=${() => void createFolder()}>创建</button>
                <button className="fp-btn" onClick=${() => { setCreating(false); setCreatingErr(null); }}>取消</button>
              </div>
              ${creatingErr ? html`<div className="fp-err">${creatingErr}</div>` : null}
            </div>`
          : null}
        ${loading ? html`<div className="fp-empty">读取中…</div>` : null}
        ${!loading && error !== null ? html`<div className="fp-err">${error}</div>` : null}
        ${!loading && error === null && cur === null
          ? html`<div
              className="fp-item fp-home"
              onClick=${() => void load(home)}
            ><span className="fp-icon">🏠</span><span className="fp-name">${home}（用户目录）</span></div>
            ${roots.map(
              (r) => html`<div key=${r} className="fp-item" onClick=${() => void load(r)}>
                <span className="fp-icon">💾</span><span className="fp-name">${r}</span>
              </div>`,
            )}`
          : null}
        ${!loading && error === null && cur !== null
          ? html`${parent !== undefined
              ? html`<div className="fp-item fp-up" onClick=${() => void load(parent)}>
                  <span className="fp-icon">↩️</span><span className="fp-name">..（上级目录）</span>
                </div>`
              : null}
            ${dirs.length === 0 && parent !== undefined
              ? html`<div className="fp-empty">（空目录）</div>`
              : null}
            ${dirs.map(
              (d) => html`<div
                key=${d}
                className="fp-item"
                onClick=${() => void load((cur.endsWith('\\') || cur.endsWith('/') ? cur : cur + '\\') + d)}
              >
                <span className="fp-icon">📁</span><span className="fp-name">${d}</span>
              </div>`,
            )}`
          : null}
      </div>

      <div className="fp-actions">
        <button className="fp-btn" onClick=${onCancel}>取消</button>
        <button className="fp-btn fp-primary" disabled=${cur === null || loading} onClick=${confirm}>
          选择此文件夹
        </button>
      </div>
    </div>
  </div>`;
}
