// 文件选择器（Composer 附件按钮）：复用 FolderPicker 的 fp-overlay/modal/pathbar/list/actions
// 样式（全屏暗色遮罩 + 居中卡片 + 面包屑 + 列表 + 底部操作），但选的是文件而非目录，
// 多选（每行独立勾选）。与 FolderPicker 同源：fs.browse(includeFiles=true) 拉数据，onPick 回调
// 把选中的绝对路径交回 Composer 走 attach.read 批量读 base64。
//
// 函数组件范式：选中集用 useState<Set>（切换时整体替换，保证 React 能感知变化）；
// 浏览数据 / 加载态分两组 state；排序与各渲染分支下沉为模块级纯函数。
// 图标 / 体积 / 路径拼接继续复用 models/ 下的零 React 类。

import { React } from '../deps.js';
import { PathJoiner } from '../models/PathJoiner.js';
import { FileIconResolver } from '../models/FileIconResolver.js';
import { FileSizeFormatter } from '../models/FileSizeFormatter.js';
import type { ApiClient } from '../../core/ApiClient.js';

/** 目录中的单个文件条目。 */
interface FsFile {
  name: string;
  size: number;
  mediaType: string;
}

/** fs.browse(includeFiles=true) 的两级返回形态。 */
type BrowseResult =
  | { level: 'drives'; roots: string[]; home: string }
  | { level: 'dir'; path: string; parent?: string; dirs: string[]; files?: FsFile[] };

/** FilePicker 组件的入参。 */
export interface FilePickerProps {
  /** ApiClient（fs.browse 含文件）。 */
  api: ApiClient;
  /** 取消选择（关闭弹窗）。 */
  onCancel: () => void;
  /** 确认：传入选中文件的绝对路径列表（Composer 再调 attach.read 读 base64）。 */
  onPick: (paths: string[]) => void;
}

/** 目录浏览数据（一次 load 整体替换）。 */
interface BrowseState {
  cur: string | null;
  dirs: string[];
  files: FsFile[];
  parent: string | undefined;
  roots: string[];
  home: string;
}

/** 加载与错误态。 */
interface LoadState {
  loading: boolean;
  error: string | null;
}

const INIT_BROWSE: BrowseState = {
  cur: null,
  dirs: [],
  files: [],
  parent: undefined,
  roots: [],
  home: '',
};

/**
 * 文件名排序（中文按拼音、忽略大小写）。
 * @param files 原始文件列表
 * @returns 排序后的新数组（不改原数组）
 */
function sortFiles(files: FsFile[]): FsFile[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }),
  );
}

/**
 * 渲染盘符层：用户目录置顶 + 各盘符。
 * @param browse 当前浏览数据
 * @param onNavigate 进入指定路径
 * @returns 盘符列表节点
 */
function renderDrives(browse: BrowseState, onNavigate: (path: string) => void): ReactElement {
  const { home, roots } = browse;
  return (
    <>
      <div className="fp-item fp-home" onClick={() => onNavigate(home)}>
        <span className="fp-icon">🏠</span>
        <span className="fp-name">{home}（用户目录）</span>
      </div>
      {roots.map((r) => (
        <div key={r} className="fp-item" onClick={() => onNavigate(r)}>
          <span className="fp-icon">💾</span>
          <span className="fp-name">{r}</span>
        </div>
      ))}
    </>
  );
}

/**
 * 渲染目录层：上级目录 + 子目录 + 文件（含勾选态）。
 * @param browse 当前浏览数据
 * @param selected 已选中的绝对路径集
 * @param onNavigate 进入目录
 * @param onToggle 勾选 / 取消勾选文件
 * @returns 列表节点
 */
function renderDirBody(
  browse: BrowseState,
  selected: ReadonlySet<string>,
  onNavigate: (path: string) => void,
  onToggle: (fullPath: string) => void,
): ReactElement {
  const { cur, dirs, parent } = browse;
  if (cur === null) return <></>;
  const files = sortFiles(browse.files);
  return (
    <>
      {parent !== undefined ? (
        <div className="fp-item fp-up" onClick={() => onNavigate(parent)}>
          <span className="fp-icon">↩️</span>
          <span className="fp-name">..（上级目录）</span>
        </div>
      ) : null}
      {dirs.length === 0 && files.length === 0 && parent !== undefined ? (
        <div className="fp-empty">（空目录）</div>
      ) : null}
      {dirs.map((d) => (
        <div
          key={'d:' + d}
          className="fp-item fp-dir"
          onClick={() => onNavigate(PathJoiner.join(cur, d))}
        >
          <span className="fp-icon">📁</span>
          <span className="fp-name">{d}</span>
        </div>
      ))}
      {files.map((f) => {
        const full = PathJoiner.join(cur, f.name);
        const sel = selected.has(full);
        return (
          <div
            key={'f:' + f.name}
            className={'fp-item fp-file' + (sel ? ' selected' : '')}
            title={`${f.name} · ${f.mediaType} · ${FileSizeFormatter.human(f.size)}`}
            onClick={() => onToggle(full)}
          >
            <span className="fp-icon">{FileIconResolver.emoji(f.mediaType)}</span>
            <span className="fp-name">{f.name}</span>
            <span className="fp-size">{FileSizeFormatter.human(f.size)}</span>
            <span className="fp-check">{sel ? '✓' : ''}</span>
          </div>
        );
      })}
    </>
  );
}

/**
 * 文件选择器：列盘符 / 目录 → 多选文件 → 确认回传绝对路径列表。
 * @param props 组件入参
 * @returns 文件选择弹窗节点
 */
export function FilePicker(props: FilePickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const [browse, setBrowse] = React.useState<BrowseState>(INIT_BROWSE);
  const [load, setLoad] = React.useState<LoadState>({ loading: false, error: null });
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set<string>());
  const { cur, loading, error } = { cur: browse.cur, loading: load.loading, error: load.error };

  /**
   * 浏览目录（含文件）：不传 path 时列盘符层。
   * @param path 目标目录（缺省列盘符）
   */
  const loadDir = async (path?: string): Promise<void> => {
    setLoad({ loading: true, error: null });
    try {
      const r: BrowseResult = await api.browseFs(path, true);
      if (r.level === 'drives') {
        setBrowse({
          roots: r.roots,
          home: r.home,
          cur: null,
          dirs: [],
          files: [],
          parent: undefined,
        });
      } else {
        setBrowse((prev) => ({
          ...prev,
          cur: r.path,
          dirs: r.dirs,
          files: r.files ?? [],
          parent: r.parent,
        }));
      }
    } catch (e) {
      setLoad((prev) => ({ ...prev, error: (e as Error).message }));
    } finally {
      setLoad((prev) => ({ ...prev, loading: false }));
    }
  };

  // 挂载即列盘符层（[] 有意：只在进入选择器时拉一次，api 由 props 注入且会话内稳定）。
  React.useEffect(() => {
    void loadDir();
  }, []);

  // Esc 关闭（依赖写全：onCancel 变化即重挂，handler 恒为最新闭包）。
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  /** 进入目录会清空选中集：跨目录选择语义不清，宁可让用户重新勾。 */
  const navigate = (path: string): void => {
    setSelected(new Set<string>());
    void loadDir(path);
  };

  /**
   * 勾选 / 取消勾选单个文件（函数式 updater，基于 prev 集合构造新集合）。
   * @param fullPath 文件绝对路径
   */
  const toggleFile = (fullPath: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };

  /** 确认：至少选一个文件才回传。 */
  const confirm = (): void => {
    if (selected.size === 0) return;
    onPick(Array.from(selected));
  };

  const selectedCount = selected.size;
  return (
    <div className="fp-overlay" onClick={onCancel}>
      <div className="fp-modal" onClick={(e: MouseEvent) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">选择附件文件</span>
          <button className="fp-close" title="关闭 (Esc)" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="fp-pathbar">
          {cur === null ? (
            <span className="fp-crumb">此电脑（选择盘符）</span>
          ) : (
            <span className="fp-crumb" title={cur}>
              {cur}
            </span>
          )}
          <span className="fp-selected-count">
            {selectedCount > 0 ? `已选 ${selectedCount} 个` : ''}
          </span>
        </div>

        <div className="fp-list">
          {loading ? <div className="fp-empty">读取中…</div> : null}
          {!loading && error !== null ? <div className="fp-err">{error}</div> : null}
          {!loading && error === null && cur === null ? renderDrives(browse, navigate) : null}
          {!loading && error === null && cur !== null
            ? renderDirBody(browse, selected, navigate, toggleFile)
            : null}
        </div>

        <div className="fp-actions">
          <button className="fp-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="fp-btn fp-primary"
            disabled={selectedCount === 0}
            onClick={confirm}
          >
            添加 {selectedCount > 0 ? selectedCount + ' 个文件' : '文件'}
          </button>
        </div>
      </div>
    </div>
  );
}
