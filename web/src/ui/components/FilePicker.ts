// 文件选择器（Composer 附件按钮）：复用 FolderPicker 的 fp-overlay/modal/pathbar/list/actions
// 样式（全屏暗色遮罩 + 居中卡片 + 面包屑 + 列表 + 底部操作），但选的是文件而非目录，
// 多选（每行独立勾选）。与 FolderPicker 同源：fs.browse(includeFiles=true) 拉数据，onPick 回调
// 把选中的绝对路径交回 Composer 走 attach.read 批量读 base64。

import { html, React } from '../deps.js';
import type { ApiClient } from '../../core/ApiClient.js';

type BrowseResult =
  | { level: 'drives'; roots: string[]; home: string }
  | {
      level: 'dir';
      path: string;
      parent?: string;
      dirs: string[];
      files?: { name: string; size: number; mediaType: string }[];
    };

export interface FilePickerProps {
  api: ApiClient;
  onCancel: () => void;
  /** 确认：传入选中文件的绝对路径列表（Composer 再调 attach.read 读 base64）。 */
  onPick: (paths: string[]) => void;
}

function fileEmoji(mediaType: string): string {
  if (mediaType.startsWith('image/')) return '🖼';
  if (mediaType.startsWith('video/')) return '🎬';
  if (mediaType.startsWith('audio/')) return '🎵';
  if (mediaType.startsWith('text/')) return '📄';
  if (mediaType.includes('pdf')) return '📕';
  if (mediaType.includes('zip') || mediaType.includes('tar') || mediaType.includes('gzip')) return '🗜';
  return '📎';
}

function humanSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 把目录路径与子项名拼成绝对路径（Windows / POSIX 兼容）。 */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') ? '\\' : '/';
  const trimmed = parent.endsWith('\\') || parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return trimmed + sep + name;
}

export function FilePicker(props: FilePickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const [cur, setCur] = React.useState<string | null>(null);
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [files, setFiles] = React.useState<{ name: string; size: number; mediaType: string }[]>([]);
  const [parent, setParent] = React.useState<string | undefined>(undefined);
  const [roots, setRoots] = React.useState<string[]>([]);
  const [home, setHome] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const r: BrowseResult = await api.browseFs(path, true);
        if (r.level === 'drives') {
          setRoots(r.roots);
          setHome(r.home);
          setCur(null);
          setDirs([]);
          setFiles([]);
          setParent(undefined);
        } else {
          setCur(r.path);
          setDirs(r.dirs);
          setFiles(r.files ?? []);
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

  /** 进入当前目录会丢弃未在此目录里选中的文件（跨目录选择语义不清）。 */
  const navigate = React.useCallback(
    (path: string) => {
      setSelected(new Set());
      void load(path);
    },
    [load],
  );

  const escHandler = React.useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    },
    [onCancel],
  );
  React.useEffect(() => {
    window.addEventListener('keydown', escHandler);
    return () => window.removeEventListener('keydown', escHandler);
  }, [escHandler]);

  const toggleFile = (fullPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };

  const confirm = () => {
    if (selected.size === 0) return;
    onPick(Array.from(selected));
  };

  const selectedCount = selected.size;
  const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }));

  return html`<div className="fp-overlay" onClick=${onCancel}>
    <div className="fp-modal" onClick=${(e: MouseEvent) => e.stopPropagation()}>
      <div className="fp-head">
        <span className="fp-title">选择附件文件</span>
        <button className="fp-close" title="关闭 (Esc)" onClick=${onCancel}>✕</button>
      </div>

      <div className="fp-pathbar">
        ${cur === null
          ? html`<span className="fp-crumb">此电脑（选择盘符）</span>`
          : html`<span className="fp-crumb" title=${cur}>${cur}</span>`}
        <span className="fp-selected-count">${selectedCount > 0 ? `已选 ${selectedCount} 个` : ''}</span>
      </div>

      <div className="fp-list">
        ${loading ? html`<div className="fp-empty">读取中…</div>` : null}
        ${!loading && error !== null ? html`<div className="fp-err">${error}</div>` : null}
        ${!loading && error === null && cur === null
          ? html`<div className="fp-item fp-home" onClick=${() => navigate(home)}>
              <span className="fp-icon">🏠</span><span className="fp-name">${home}（用户目录）</span>
            </div>
            ${roots.map(
              (r) => html`<div key=${r} className="fp-item" onClick=${() => navigate(r)}>
                <span className="fp-icon">💾</span><span className="fp-name">${r}</span>
              </div>`,
            )}`
          : null}
        ${!loading && error === null && cur !== null
          ? html`${parent !== undefined
              ? html`<div className="fp-item fp-up" onClick=${() => navigate(parent)}>
                  <span className="fp-icon">↩️</span><span className="fp-name">..（上级目录）</span>
                </div>`
              : null}
            ${dirs.length === 0 && files.length === 0 && parent !== undefined
              ? html`<div className="fp-empty">（空目录）</div>`
              : null}
            ${dirs.map(
              (d) => html`<div
                key=${'d:' + d}
                className="fp-item fp-dir"
                onClick=${() => navigate(joinPath(cur, d))}
              >
                <span className="fp-icon">📁</span><span className="fp-name">${d}</span>
              </div>`,
            )}
            ${sortedFiles.map(
              (f) => {
                const full = joinPath(cur, f.name);
                const sel = selected.has(full);
                return html`<div
                  key=${'f:' + f.name}
                  className=${'fp-item fp-file' + (sel ? ' selected' : '')}
                  title=${`${f.name} · ${f.mediaType} · ${humanSize(f.size)}`}
                  onClick=${() => toggleFile(full)}
                >
                  <span className="fp-icon">${fileEmoji(f.mediaType)}</span>
                  <span className="fp-name">${f.name}</span>
                  <span className="fp-size">${humanSize(f.size)}</span>
                  <span className="fp-check">${sel ? '✓' : ''}</span>
                </div>`;
              },
            )}`
          : null}
      </div>

      <div className="fp-actions">
        <button className="fp-btn" onClick=${onCancel}>取消</button>
        <button
          className="fp-btn fp-primary"
          disabled=${selectedCount === 0}
          onClick=${confirm}
        >添加 ${selectedCount > 0 ? selectedCount + ' 个文件' : '文件'}</button>
      </div>
    </div>
  </div>`;
}
