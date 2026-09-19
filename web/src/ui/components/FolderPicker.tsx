// 文件夹选择器（+ 添加项目）：服务端 fs.browse 驱动的目录浏览器。
// 浏览器沙箱拿不到本机绝对路径，window.prompt 手输已被否——由本地服务端列目录、
// UI 内嵌选择，选中即得真实绝对路径。
//
// 函数组件范式：原「九份扁平 state」按语义收成三组（浏览数据 / 加载态 / 新建态），
// 渲染分支下沉为模块级函数（零组件耦合）；Esc 监听依赖 create.creating，handler 恒读最新值。

import { React } from '../deps.js';
import { PathJoiner } from '../models/PathJoiner.js';
import type { ApiClient } from '../../core/ApiClient.js';

/** fs.browse 的两级返回形态。 */
type BrowseResult =
  | { level: 'drives'; roots: string[]; home: string }
  | { level: 'dir'; path: string; parent?: string; dirs: string[] };

/** FolderPicker 组件的入参。 */
export interface FolderPickerProps {
  /** ApiClient（fs.browse / fs.mkdir）。 */
  api: ApiClient;
  /** 取消选择（关闭弹窗）。 */
  onCancel: () => void;
  /** 确认选择：传入选中目录的绝对路径。 */
  onPick: (path: string) => void;
}

/** 目录浏览数据（一次 load 整体替换）。 */
interface BrowseState {
  cur: string | null;
  dirs: string[];
  parent: string | undefined;
  roots: string[];
  home: string;
}

/** 加载与错误态。 */
interface LoadState {
  loading: boolean;
  error: string | null;
}

/** 新建文件夹态。 */
interface CreateState {
  creating: boolean;
  newName: string;
  creatingErr: string | null;
}

const INIT_BROWSE: BrowseState = {
  cur: null,
  dirs: [],
  parent: undefined,
  roots: [],
  home: '',
};

/** 新建文件夹的默认名称（用户可直接回车确认）。 */
const DEFAULT_NEW_NAME = '新项目';

/**
 * 渲染盘符层：用户目录置顶 + 各盘符。
 * @param browse 当前浏览数据
 * @param onLoad 进入指定路径
 * @returns 盘符列表节点
 */
function renderDrives(browse: BrowseState, onLoad: (path?: string) => void): ReactElement {
  const { home, roots } = browse;
  return (
    <>
      <div className="fp-item fp-home" onClick={() => onLoad(home)}>
        <span className="fp-icon">🏠</span>
        <span className="fp-name">{home}（用户目录）</span>
      </div>
      {roots.map((r) => (
        <div key={r} className="fp-item" onClick={() => onLoad(r)}>
          <span className="fp-icon">💾</span>
          <span className="fp-name">{r}</span>
        </div>
      ))}
    </>
  );
}

/**
 * 渲染目录层：上级目录 + 子目录列表。
 * @param browse 当前浏览数据
 * @param onLoad 进入指定路径
 * @returns 目录列表节点
 */
function renderDirs(browse: BrowseState, onLoad: (path?: string) => void): ReactElement {
  const { cur, dirs, parent } = browse;
  if (cur === null) return <></>;
  return (
    <>
      {parent !== undefined ? (
        <div className="fp-item fp-up" onClick={() => onLoad(parent)}>
          <span className="fp-icon">↩️</span>
          <span className="fp-name">..（上级目录）</span>
        </div>
      ) : null}
      {dirs.length === 0 && parent !== undefined ? <div className="fp-empty">（空目录）</div> : null}
      {dirs.map((d) => (
        <div key={d} className="fp-item" onClick={() => onLoad(PathJoiner.join(cur, d))}>
          <span className="fp-icon">📁</span>
          <span className="fp-name">{d}</span>
        </div>
      ))}
    </>
  );
}

/**
 * 渲染「新建文件夹」输入区。
 * @param state 新建态
 * @param cur 当前目录（展示用）
 * @param hooks 输入变更 / 创建 / 取消三个回调
 * @returns 新建区节点
 */
function renderCreateBar(
  state: CreateState,
  cur: string | null,
  hooks: { onChange: (v: string) => void; onCreate: () => void; onCancel: () => void },
): ReactElement {
  return (
    <div className="fp-create">
      <span className="fp-create-label">在 {cur ?? ''} 内新建：</span>
      <div className="fp-create-row">
        <input
          className="fp-input"
          value={state.newName}
          placeholder="文件夹名称"
          onInput={(e: Event) => hooks.onChange((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') hooks.onCreate();
          }}
        />
        <button className="fp-btn fp-primary" onClick={hooks.onCreate}>
          创建
        </button>
        <button className="fp-btn" onClick={hooks.onCancel}>
          取消
        </button>
      </div>
      {state.creatingErr ? <div className="fp-err">{state.creatingErr}</div> : null}
    </div>
  );
}

/**
 * 目录选择器：列盘符 → 逐级浏览 → 选中当前目录或新建项目文件夹。
 * @param props 组件入参
 * @returns 目录选择弹窗节点
 */
export function FolderPicker(props: FolderPickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const [browse, setBrowse] = React.useState<BrowseState>(INIT_BROWSE);
  const [load, setLoad] = React.useState<LoadState>({ loading: false, error: null });
  const [create, setCreate] = React.useState<CreateState>({
    creating: false,
    newName: '',
    creatingErr: null,
  });
  const { cur, loading, error } = { cur: browse.cur, loading: load.loading, error: load.error };

  /**
   * 浏览目录：不传 path 时列盘符层。
   * @param path 目标目录（缺省列盘符）
   */
  const loadDir = async (path?: string): Promise<void> => {
    setLoad({ loading: true, error: null });
    try {
      const r: BrowseResult = await api.browseFs(path);
      if (r.level === 'drives') {
        setBrowse({ roots: r.roots, home: r.home, cur: null, dirs: [], parent: undefined });
      } else {
        setBrowse((prev) => ({ ...prev, cur: r.path, dirs: r.dirs, parent: r.parent }));
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

  // Esc 关闭；若在新建态则先退出新建（就近取消，避免误关整个弹窗）。依赖 creation 态以读最新值。
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (create.creating) {
        setCreate((prev) => ({ ...prev, creating: false, creatingErr: null }));
        return;
      }
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [create.creating, onCancel]);

  /** 确认：盘符层禁用（必须进到具体目录），目录层返回当前路径。 */
  const confirm = (): void => {
    if (browse.cur !== null) onPick(browse.cur);
  };

  /** 进入新建态。 */
  const startCreate = (): void => {
    setCreate({ creating: true, creatingErr: null, newName: DEFAULT_NEW_NAME });
  };

  /** 取消新建态。 */
  const cancelCreate = (): void => {
    setCreate((prev) => ({ ...prev, creating: false, creatingErr: null }));
  };

  /** 新建文件夹：在当前目录内创建子目录，建完即作为项目返回（会话归属它管理）。 */
  const createFolder = async (): Promise<void> => {
    const target = browse.cur;
    if (target === null) return;
    const name = create.newName.trim();
    if (name === '') {
      setCreate((prev) => ({ ...prev, creatingErr: '请输入文件夹名称' }));
      return;
    }
    setCreate((prev) => ({ ...prev, creatingErr: null }));
    try {
      const r = await api.mkdirFs(target, name);
      setCreate({ creating: false, newName: '', creatingErr: null });
      // 建完直接选回：SessionPanel 会 addWorkspace + switchWorkspace，会话归它管。
      onPick(r.path);
    } catch (e) {
      setCreate((prev) => ({ ...prev, creatingErr: (e as Error).message }));
    }
  };

  return (
    <div className="fp-overlay" onClick={onCancel}>
      <div className="fp-modal" onClick={(e: MouseEvent) => e.stopPropagation()}>
        <div className="fp-head">
          <span className="fp-title">选择项目文件夹</span>
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
          <button
            className="fp-new"
            title="在当前目录内新建项目文件夹"
            disabled={cur === null || loading}
            onClick={startCreate}
          >
            📂 新建文件夹
          </button>
        </div>

        <div className="fp-list">
          {create.creating
            ? renderCreateBar(create, cur, {
                onChange: (v) => setCreate((prev) => ({ ...prev, newName: v })),
                onCreate: () => void createFolder(),
                onCancel: cancelCreate,
              })
            : null}
          {loading ? <div className="fp-empty">读取中…</div> : null}
          {!loading && error !== null ? <div className="fp-err">{error}</div> : null}
          {!loading && error === null && cur === null ? renderDrives(browse, (p) => void loadDir(p)) : null}
          {!loading && error === null && cur !== null ? renderDirs(browse, (p) => void loadDir(p)) : null}
        </div>

        <div className="fp-actions">
          <button className="fp-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="fp-btn fp-primary"
            disabled={cur === null || loading}
            onClick={confirm}
          >
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
