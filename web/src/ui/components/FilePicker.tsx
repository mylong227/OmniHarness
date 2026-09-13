// 文件选择器（Composer 附件按钮）：复用 FolderPicker 的 fp-overlay/modal/pathbar/list/actions
// 样式（全屏暗色遮罩 + 居中卡片 + 面包屑 + 列表 + 底部操作），但选的是文件而非目录，
// 多选（每行独立勾选）。与 FolderPicker 同源：fs.browse(includeFiles=true) 拉数据，onPick 回调
// 把选中的绝对路径交回 Composer 走 attach.read 批量读 base64。
//
// 面向对象改造：选中集用 Set 存于 state（切换时整体替换，保证 React 能感知变化）；
// 图标 / 体积 / 路径拼接下沉到 models/ 下的三个零 React 类，本文件只做渲染与交互。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import { PathJoiner } from '../models/PathJoiner.js';
import { FileIconResolver } from '../models/FileIconResolver.js';
import { FileSizeFormatter } from '../models/FileSizeFormatter.js';
import type { ApiClient } from '../../core/ApiClient.js';

interface FsFile {
  name: string;
  size: number;
  mediaType: string;
}

type BrowseResult =
  | { level: 'drives'; roots: string[]; home: string }
  | { level: 'dir'; path: string; parent?: string; dirs: string[]; files?: FsFile[] };

export interface FilePickerProps {
  api: ApiClient;
  onCancel: () => void;
  /** 确认：传入选中文件的绝对路径列表（Composer 再调 attach.read 读 base64）。 */
  onPick: (paths: string[]) => void;
}

interface FilePickerState {
  cur: string | null;
  dirs: string[];
  files: FsFile[];
  parent: string | undefined;
  roots: string[];
  home: string;
  error: string | null;
  loading: boolean;
  selected: Set<string>;
}

/** 文件选择器（多选）。 */
export class FilePicker extends AppComponent<FilePickerProps, FilePickerState> {
  constructor(props: FilePickerProps) {
    super(props);
    this.state = {
      cur: null,
      dirs: [],
      files: [],
      parent: undefined,
      roots: [],
      home: '',
      error: null,
      loading: false,
      selected: new Set<string>(),
    };
  }

  override componentDidMount(): void {
    void this.load();
    window.addEventListener('keydown', this.onKeyDown);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.props.onCancel();
  };

  /** 浏览目录（含文件）：不传 path 时列盘符层。 */
  private async load(path?: string): Promise<void> {
    this.setState({ loading: true, error: null });
    try {
      const r: BrowseResult = await this.props.api.browseFs(path, true);
      if (r.level === 'drives') {
        this.setState({
          roots: r.roots,
          home: r.home,
          cur: null,
          dirs: [],
          files: [],
          parent: undefined,
        });
      } else {
        this.setState({ cur: r.path, dirs: r.dirs, files: r.files ?? [], parent: r.parent });
      }
    } catch (e) {
      this.setState({ error: (e as Error).message });
    } finally {
      this.setState({ loading: false });
    }
  }

  /** 进入目录会清空选中集：跨目录选择语义不清，宁可让用户重新勾。 */
  private navigate(path: string): void {
    this.setState({ selected: new Set<string>() });
    void this.load(path);
  }

  /** 勾选 / 取消勾选单个文件。 */
  private readonly toggleFile = (fullPath: string): void => {
    this.setState((prev) => {
      const next = new Set(prev.selected);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return { selected: next };
    });
  };

  private readonly confirm = (): void => {
    const { selected } = this.state;
    if (selected.size === 0) return;
    this.props.onPick(Array.from(selected));
  };

  /** 文件名排序（中文按拼音、忽略大小写）。 */
  private sortedFiles(): FsFile[] {
    return [...this.state.files].sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }),
    );
  }

  private renderDrives(): ReactElement {
    const { home, roots } = this.state;
    return (
      <>
        <div className="fp-item fp-home" onClick={() => this.navigate(home)}>
          <span className="fp-icon">🏠</span>
          <span className="fp-name">{home}（用户目录）</span>
        </div>
        {roots.map((r) => (
          <div key={r} className="fp-item" onClick={() => this.navigate(r)}>
            <span className="fp-icon">💾</span>
            <span className="fp-name">{r}</span>
          </div>
        ))}
      </>
    );
  }

  private renderFile(f: FsFile, cur: string): ReactElement {
    const full = PathJoiner.join(cur, f.name);
    const sel = this.state.selected.has(full);
    return (
      <div
        key={'f:' + f.name}
        className={'fp-item fp-file' + (sel ? ' selected' : '')}
        title={`${f.name} · ${f.mediaType} · ${FileSizeFormatter.human(f.size)}`}
        onClick={() => this.toggleFile(full)}
      >
        <span className="fp-icon">{FileIconResolver.emoji(f.mediaType)}</span>
        <span className="fp-name">{f.name}</span>
        <span className="fp-size">{FileSizeFormatter.human(f.size)}</span>
        <span className="fp-check">{sel ? '✓' : ''}</span>
      </div>
    );
  }

  private renderDir(): ReactElement {
    const { cur, dirs, parent } = this.state;
    if (cur === null) return <></>;
    const files = this.sortedFiles();
    return (
      <>
        {parent !== undefined ? (
          <div className="fp-item fp-up" onClick={() => this.navigate(parent as string)}>
            <span className="fp-icon">↩️</span>
            <span className="fp-name">..（上级目录）</span>
          </div>
        ) : null}
        {dirs.length === 0 && files.length === 0 && parent !== undefined ? (
          <div className="fp-empty">（空目录）</div>
        ) : null}
        {dirs.map((d) => (
          <div key={'d:' + d} className="fp-item fp-dir" onClick={() => this.navigate(PathJoiner.join(cur, d))}>
            <span className="fp-icon">📁</span>
            <span className="fp-name">{d}</span>
          </div>
        ))}
        {files.map((f) => this.renderFile(f, cur))}
      </>
    );
  }

  override render(): ReactElement {
    const { onCancel } = this.props;
    const { cur, loading, error, selected } = this.state;
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
            {!loading && error === null && cur === null ? this.renderDrives() : null}
            {!loading && error === null && cur !== null ? this.renderDir() : null}
          </div>

          <div className="fp-actions">
            <button className="fp-btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="fp-btn fp-primary"
              disabled={selectedCount === 0}
              onClick={this.confirm}
            >
              添加 {selectedCount > 0 ? selectedCount + ' 个文件' : '文件'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
