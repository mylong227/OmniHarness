// 文件选择器（Composer 附件按钮）：复用 FolderPicker 的 fp-overlay/modal/pathbar/list/actions
// 样式（全屏暗色遮罩 + 居中卡片 + 面包屑 + 列表 + 底部操作），但选的是文件而非目录，
// 多选（每行独立勾选）。与 FolderPicker 同源：fs.browse(includeFiles=true) 拉数据，onPick 回调
// 把选中的绝对路径交回 Composer 走 attach.read 批量读 base64。
//
// 函数组件范式：选中集用 useState<Set>（切换时整体替换，保证 React 能感知变化）；
// 浏览数据 / 加载态分两组 state；排序与各渲染分支下沉为模块级纯函数。
// 图标 / 体积 / 路径拼接继续复用 models/ 下的零 React 类。

import * as React from 'react';
import { PathJoiner } from '../models/PathJoiner.ts';
import { FileIconResolver } from '../models/FileIconResolver.ts';
import { FileSizeFormatter } from '../models/FileSizeFormatter.ts';
import { icon } from '../models/Icon.ts';
import { ActivationKeys } from '../models/ActivationKeys.ts';
import { useModalFocus } from './useModalFocus.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import { t } from '../i18n/i18n.ts';

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
 * 目录浏览数据源（盘符/目录加载 + 代际防串）。
 * @param api RPC 客户端。
 * @returns 浏览态、加载态与 loadDir。
 */
function useFileBrowser(api: ApiClient): {
  browse: BrowseState;
  load: LoadState;
  loadDir: (path?: string) => Promise<void>;
} {
  const [browse, setBrowse] = React.useState<BrowseState>(INIT_BROWSE);
  const [load, setLoad] = React.useState<LoadState>({ loading: false, error: null });
  const loadSeq = React.useRef<number>(0);
  const loadDir = async (path?: string): Promise<void> => {
    const seq = ++loadSeq.current;
    setLoad({ loading: true, error: null });
    try {
      const r: BrowseResult = await api.browseFs(path, true);
      if (seq !== loadSeq.current) return;
      if (r.level === 'drives') {
        setBrowse({
          roots: Array.isArray(r.roots) ? r.roots : [],
          home: typeof r.home === 'string' ? r.home : '',
          cur: null,
          dirs: [],
          files: [],
          parent: undefined,
        });
      } else if (r.level === 'dir' && Array.isArray(r.dirs)) {
        setBrowse((prev) => ({
          ...prev,
          cur: r.path,
          dirs: r.dirs,
          files: Array.isArray(r.files) ? r.files : [],
          parent: r.parent,
        }));
      } else {
        setLoad((prev) => ({ ...prev, error: t('文件列表返回格式异常（fs.browse）') }));
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoad((prev) => ({ ...prev, error: (e as Error).message }));
    } finally {
      if (seq === loadSeq.current) setLoad((prev) => ({ ...prev, loading: false }));
    }
  };
  React.useEffect(() => {
    void loadDir();
  }, []);
  return { browse, load, loadDir };
}

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
      <div
        className="fp-item fp-home"
        tabIndex={0}
        onClick={() => onNavigate(home)}
        onKeyDown={(e: React.KeyboardEvent) => ActivationKeys.activate(e, () => onNavigate(home))}
      >
        <span className="fp-icon">{icon('home', { size: 15 })}</span>
        <span className="fp-name">{home}{t('（用户目录）')}</span>
      </div>
      {roots.map((r) => (
        <div
          key={r}
          className="fp-item"
          tabIndex={0}
          onClick={() => onNavigate(r)}
          onKeyDown={(e: React.KeyboardEvent) => ActivationKeys.activate(e, () => onNavigate(r))}
        >
          <span className="fp-icon">{icon('drive', { size: 15 })}</span>
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
        <div
          className="fp-item fp-up"
          tabIndex={0}
          onClick={() => onNavigate(parent)}
          onKeyDown={(e: React.KeyboardEvent) => ActivationKeys.activate(e, () => onNavigate(parent))}
        >
          <span className="fp-icon">{icon('undo', { size: 15 })}</span>
          <span className="fp-name">{t('..（上级目录）')}</span>
        </div>
      ) : null}
      {dirs.length === 0 && files.length === 0 && parent !== undefined ? (
        <div className="fp-empty">{t('（空目录）')}</div>
      ) : null}
      {dirs.map((d) => (
        <div
          key={'d:' + d}
          className="fp-item fp-dir"
          tabIndex={0}
          onClick={() => onNavigate(PathJoiner.join(cur, d))}
          onKeyDown={(e: React.KeyboardEvent) =>
            ActivationKeys.activate(e, () => onNavigate(PathJoiner.join(cur, d)))
          }
        >
          <span className="fp-icon">{icon('folder', { size: 15 })}</span>
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
            role="checkbox"
            aria-checked={sel ? 'true' : 'false'}
            tabIndex={0}
            onClick={() => onToggle(full)}
            onKeyDown={(e: React.KeyboardEvent) => ActivationKeys.activate(e, () => onToggle(full))}
          >
            <span className="fp-icon">{icon(FileIconResolver.iconName(f.mediaType), { size: 15 })}</span>
            <span className="fp-name">{f.name}</span>
            <span className="fp-size">{FileSizeFormatter.human(f.size)}</span>
            <span className="fp-check">{sel ? icon('check', { size: 12 }) : null}</span>
          </div>
        );
      })}
    </>
  );
}

/**
 * 选择器主体（路径栏 + 列表 + 动作）。
 * @param props 浏览态、选中集与回调。
 * @returns 主体节点。
 */
function FilePickerBody(props: {
  browse: BrowseState;
  cur: string | null;
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  selectedCount: number;
  navigate: (path: string) => void;
  toggleFile: (path: string) => void;
  onCancel: () => void;
  confirm: () => void;
}): ReactElement {
  return (
    <>
      <div className="fp-pathbar">
        {props.cur === null ? (
          <span className="fp-crumb">{t('此电脑（选择盘符）')}</span>
        ) : (
          <span className="fp-crumb" title={props.cur}>
            {props.cur}
          </span>
        )}
        <span className="fp-selected-count">
          {props.selectedCount > 0 ? t('已选 {count} 个', { count: props.selectedCount }) : ''}
        </span>
      </div>
      <div className="fp-list">
        {props.loading ? <div className="fp-empty">{t('读取中…')}</div> : null}
        {!props.loading && props.error !== null ? <div className="fp-err">{props.error}</div> : null}
        {!props.loading && props.error === null && props.cur === null
          ? renderDrives(props.browse, props.navigate)
          : null}
        {!props.loading && props.error === null && props.cur !== null
          ? renderDirBody(props.browse, props.selected, props.navigate, props.toggleFile)
          : null}
      </div>
      <div className="fp-actions">
        <button className="fp-btn" onClick={props.onCancel}>
          {t('取消')}
        </button>
        <button
          className="fp-btn fp-primary"
          disabled={props.selectedCount === 0}
          onClick={props.confirm}
        >
          {props.selectedCount > 0
            ? t('添加 {count} 个文件', { count: props.selectedCount })
            : t('添加文件')}
        </button>
      </div>
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
  const { browse, load, loadDir } = useFileBrowser(api);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set<string>());
  /** 模态焦点：收拢 / 归还 opener / Tab 陷阱（见 useModalFocus）。 */
  const modal = useModalFocus();
  const { cur, loading, error } = { cur: browse.cur, loading: load.loading, error: load.error };

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
      <div
        className="fp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('选择附件文件')}
        tabIndex={-1}
        ref={modal.modalRef}
        onKeyDown={modal.onKeyDown}
      >
        <div className="fp-head">
          <span className="fp-title">{t('选择附件文件')}</span>
          <button className="fp-close" title={t('关闭 (Esc)')} onClick={onCancel}>
            {icon('x', { size: 14 })}
          </button>
        </div>

        <FilePickerBody
          browse={browse}
          cur={cur}
          loading={loading}
          error={error}
          selected={selected}
          selectedCount={selectedCount}
          navigate={navigate}
          toggleFile={toggleFile}
          onCancel={onCancel}
          confirm={confirm}
        />
      </div>
    </div>
  );
}
