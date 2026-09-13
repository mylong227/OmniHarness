// 文件夹选择器（+ 添加项目）：服务端 fs.browse 驱动的目录浏览器。
// 浏览器沙箱拿不到本机绝对路径，window.prompt 手输已被否——由本地服务端列目录、
// UI 内嵌选择，选中即得真实绝对路径。
//
// 面向对象改造：九份 state 收敛为单一 state 对象；Esc 键与目录加载改为实例方法
// （监听只挂一次，handler 读 this.state/this.props，无闭包过期问题）。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import { PathJoiner } from '../models/PathJoiner.js';
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

interface FolderPickerState {
  cur: string | null;
  dirs: string[];
  parent: string | undefined;
  roots: string[];
  home: string;
  error: string | null;
  loading: boolean;
  /** 新建文件夹模式：true 时列表上方显示名称输入框。 */
  creating: boolean;
  newName: string;
  creatingErr: string | null;
}

/** 新建文件夹的默认名称（用户可直接回车确认）。 */
const DEFAULT_NEW_NAME = '新项目';

/** 目录选择器。 */
export class FolderPicker extends AppComponent<FolderPickerProps, FolderPickerState> {
  constructor(props: FolderPickerProps) {
    super(props);
    this.state = {
      cur: null,
      dirs: [],
      parent: undefined,
      roots: [],
      home: '',
      error: null,
      loading: false,
      creating: false,
      newName: '',
      creatingErr: null,
    };
  }

  override componentDidMount(): void {
    void this.load();
    window.addEventListener('keydown', this.onKeyDown);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('keydown', this.onKeyDown);
  }

  /** Esc 关闭；若在新建态则先退出新建（就近取消，避免误关整个弹窗）。 */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.state.creating) {
      this.setState({ creating: false, creatingErr: null });
      return;
    }
    if (e.key === 'Escape') this.props.onCancel();
  };

  /** 浏览目录：不传 path 时列盘符层。 */
  private async load(path?: string): Promise<void> {
    this.setState({ loading: true, error: null });
    try {
      const r: BrowseResult = await this.props.api.browseFs(path);
      if (r.level === 'drives') {
        this.setState({ roots: r.roots, home: r.home, cur: null, dirs: [], parent: undefined });
      } else {
        this.setState({ cur: r.path, dirs: r.dirs, parent: r.parent });
      }
    } catch (e) {
      this.setState({ error: (e as Error).message });
    } finally {
      this.setState({ loading: false });
    }
  }

  /** 确认：盘符层禁用（必须进到具体目录），目录层返回当前路径。 */
  private readonly confirm = (): void => {
    const { cur } = this.state;
    if (cur !== null) this.props.onPick(cur);
  };

  /** 进入新建态。 */
  private readonly startCreate = (): void => {
    this.setState({ creating: true, creatingErr: null, newName: DEFAULT_NEW_NAME });
  };

  /** 取消新建态。 */
  private readonly cancelCreate = (): void => {
    this.setState({ creating: false, creatingErr: null });
  };

  /** 新建文件夹：在当前目录内创建子目录，建完即作为项目返回（会话归属它管理）。 */
  private async createFolder(): Promise<void> {
    const { cur, newName } = this.state;
    if (cur === null) return;
    const name = newName.trim();
    if (name === '') {
      this.setState({ creatingErr: '请输入文件夹名称' });
      return;
    }
    this.setState({ creatingErr: null });
    try {
      const r = await this.props.api.mkdirFs(cur, name);
      this.setState({ creating: false, newName: '' });
      // 建完直接选回：SessionPanel 会 addWorkspace + switchWorkspace，会话归它管。
      this.props.onPick(r.path);
    } catch (e) {
      this.setState({ creatingErr: (e as Error).message });
    }
  }

  /** 渲染盘符层：用户目录置顶 + 各盘符。 */
  private renderDrives(): ReactElement {
    const { home, roots } = this.state;
    return (
      <>
        <div className="fp-item fp-home" onClick={() => void this.load(home)}>
          <span className="fp-icon">🏠</span>
          <span className="fp-name">{home}（用户目录）</span>
        </div>
        {roots.map((r) => (
          <div key={r} className="fp-item" onClick={() => void this.load(r)}>
            <span className="fp-icon">💾</span>
            <span className="fp-name">{r}</span>
          </div>
        ))}
      </>
    );
  }

  /** 渲染目录层：上级目录 + 子目录列表。 */
  private renderDirs(): ReactElement {
    const { cur, dirs, parent } = this.state;
    if (cur === null) return <></>;
    return (
      <>
        {parent !== undefined ? (
          <div className="fp-item fp-up" onClick={() => void this.load(parent)}>
            <span className="fp-icon">↩️</span>
            <span className="fp-name">..（上级目录）</span>
          </div>
        ) : null}
        {dirs.length === 0 && parent !== undefined ? <div className="fp-empty">（空目录）</div> : null}
        {dirs.map((d) => (
          <div key={d} className="fp-item" onClick={() => void this.load(PathJoiner.join(cur, d))}>
            <span className="fp-icon">📁</span>
            <span className="fp-name">{d}</span>
          </div>
        ))}
      </>
    );
  }

  override render(): ReactElement {
    const { onCancel } = this.props;
    const { cur, loading, error, creating, newName, creatingErr } = this.state;
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
              onClick={this.startCreate}
            >
              📂 新建文件夹
            </button>
          </div>

          <div className="fp-list">
            {creating ? (
              <div className="fp-create">
                <span className="fp-create-label">在 {cur ?? ''} 内新建：</span>
                <div className="fp-create-row">
                  <input
                    className="fp-input"
                    value={newName}
                    placeholder="文件夹名称"
                    onInput={(e: Event) =>
                      this.setState({ newName: (e.target as HTMLInputElement).value })
                    }
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === 'Enter') void this.createFolder();
                    }}
                  />
                  <button className="fp-btn fp-primary" onClick={() => void this.createFolder()}>
                    创建
                  </button>
                  <button className="fp-btn" onClick={this.cancelCreate}>
                    取消
                  </button>
                </div>
                {creatingErr ? <div className="fp-err">{creatingErr}</div> : null}
              </div>
            ) : null}
            {loading ? <div className="fp-empty">读取中…</div> : null}
            {!loading && error !== null ? <div className="fp-err">{error}</div> : null}
            {!loading && error === null && cur === null ? this.renderDrives() : null}
            {!loading && error === null && cur !== null ? this.renderDirs() : null}
          </div>

          <div className="fp-actions">
            <button className="fp-btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="fp-btn fp-primary"
              disabled={cur === null || loading}
              onClick={this.confirm}
            >
              选择此文件夹
            </button>
          </div>
        </div>
      </div>
    );
  }
}
