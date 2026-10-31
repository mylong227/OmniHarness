// 文件选择器（附件多选）—— 2026-10-30 重设计 P1（docs/PICKER_REDESIGN_2026-10-30.md）。
//
// 数据源从「逐级 fs.browse 的导航隐喻」换成「一次 fs.list 的整棵工作区树」：
//   · 空间隐喻：树常驻，展开目录不再换一屏，始终看得见自己在哪、邻居是谁；
//   · 跨目录多选：勾选集是路径集合，展开/过滤都**不清空**（旧实现进目录即清空）；
//   · 过滤：已加载树上的客户端过滤（无新增后端接口），过滤后勾选集不丢；
//   · 刷新：重拉 fs.list，展开键与勾选键都是路径，天然稳定。
//
// 未纳入本期：工作区之外的「文件系统…」懒加载子树（P2）、右侧预览窗格（P3）。
// 保留契约：`PickerModal` 的 Esc 关闭与焦点归还；页脚「0 选择禁用确认」；回传绝对路径数组。

import * as React from 'react';
import { Tree } from 'antd';
import type { TreeDataNode } from 'antd';
import { PickerModal } from './PickerModal.tsx';
import { icon } from '../models/Icon.ts';
import { FileSizeFormatter } from '../models/FileSizeFormatter.ts';
import { FS_ROOT, fsKeyOf, fsPathOf, isFsKey } from '../models/FsPickerLazy.ts';
import type { ApiClient } from '../../core/ApiClient.ts';
import type { FsNode } from '../../types/models.ts';
import { t } from '../i18n/i18n.ts';

/** `fs.list` 的默认深度（与侧栏文件树一致；超深目录本期不续接，见设计 §10 风险登记）。 */
const DEPTH = 3;

/** FilePicker 组件的入参。 */
export interface FilePickerProps {
  /** ApiClient（fs.list 取整棵工作区树）。 */
  api: ApiClient;
  /** 取消选择（关闭弹窗）。 */
  onCancel: () => void;
  /** 确认：传入选中文件的绝对路径列表（Composer 再调 attach.read 读 base64）。 */
  onPick: (paths: string[]) => void;
}

/** 工作区树的数据态。 */
interface TreeState {
  tree: FsNode[];
  loading: boolean;
  error: string | null;
}

/**
 * 拉工作区整树（`fs.list`）：首开一次，刷新按钮再拉一次。
 *
 * 与旧的逐目录代际守卫不同：这里只有**一个**请求，不存在"后到的旧目录响应改写列表"的竞态；
 * 但刷新可以与首次加载重叠，故仍用序号丢弃过期响应（语义变成"最后一次刷新为准"）。
 *
 * @param api RPC 客户端
 * @returns 数据态与 refresh
 */
function useWorkspaceTree(api: ApiClient): TreeState & { refresh: () => void } {
  const [state, setState] = React.useState<TreeState>({ tree: [], loading: true, error: null });
  const seq = React.useRef(0);

  const load = React.useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const r = await api.listFs(DEPTH);
      if (mine !== seq.current) return;
      if (!Array.isArray(r?.tree)) {
        // fail-closed：形状不合法 ⇒ 当作读取失败，绝不把 undefined 灌进树。
        setState({ tree: [], loading: false, error: t('文件树返回格式异常（fs.list）') });
        return;
      }
      setState({ tree: r.tree, loading: false, error: null });
    } catch (e) {
      if (mine !== seq.current) return;
      setState({ tree: [], loading: false, error: (e as Error).message });
    }
  }, [api]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return { ...state, refresh: () => void load() };
}

/**
 * 客户端过滤：保留命中节点及其祖先（命中的子树原样保留，便于继续展开）。
 * @param nodes 原始树
 * @param query 关键字（小写无关；空串返回原树）
 * @returns 过滤后的树（新数组，不改原节点）
 */
function filterFs(nodes: readonly FsNode[], query: string): FsNode[] {
  if (query === '') return [...nodes];
  const needle = query.toLowerCase();
  const out: FsNode[] = [];
  for (const node of nodes) {
    const children = node.children === undefined ? [] : filterFs(node.children, query);
    const hit = node.name.toLowerCase().includes(needle);
    if (!hit && children.length === 0) continue;
    out.push(children.length > 0 ? { ...node, children } : { ...node });
  }
  return out;
}

/**
 * 树的全部目录键（过滤后自动展开用）。
 * @param nodes 树
 * @returns 目录路径数组
 */
function dirKeysOf(nodes: readonly FsNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'dir') continue;
    out.push(node.path);
    if (node.children !== undefined) out.push(...dirKeysOf(node.children));
  }
  return out;
}

/**
 * 文件节点的图标（`FsNode` 不带 mediaType，按扩展名粗判；判错只是图标不准）。
 * @param name 文件名
 * @returns 图标名
 */
function fileIconOf(name: string): 'image' | 'file' {
  return /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(name) ? 'image' : 'file';
}

/**
 * `FsNode` → antd TreeDataNode（key = 绝对路径，文件名 + 图标做标题）。
 * @param node 文件树节点
 * @returns treeData 节点
 */
function toTreeNode(node: FsNode): TreeDataNode {
  const title = (
    <span className="fp-node">
      <span className="fp-node-icon" aria-hidden="true">
        {icon(node.type === 'dir' ? 'folder' : fileIconOf(node.name), { size: 14 })}
      </span>
      <span className="fp-node-name">{node.name}</span>
    </span>
  );
  const children = node.children?.map(toTreeNode);
  return {
    key: node.path,
    title,
    isLeaf: node.type === 'file',
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  };
}

/**
 * 收集树里所有**文件**路径（勾选集只允许文件；目录勾选语义留待显式"勾选目录内全部"）。
 * @param nodes 树
 * @returns 文件路径数组
 */
function fileKeysOf(nodes: readonly FsNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'file') out.push(node.path);
    else if (node.children !== undefined) out.push(...fileKeysOf(node.children));
  }
  return out;
}

/** 懒加载节点状态：children 为 null = 尚未加载。 */
interface LazyNode {
  children: TreeDataNode[] | null;
  /** 该节点下的文件 key（勾选闸用：懒加载目录的 key 也在 checkedKeys 里出现）。 */
  files: Set<string>;
  loading: boolean;
  error: string | null;
}

/** `fs.browse(includeFiles=true)` 的回包。 */
type BrowseWithFiles =
  | { level: 'drives'; roots: string[]; home: string }
  | {
      level: 'dir';
      path: string;
      dirs: string[];
      files?: { name: string; size: number; mediaType: string }[];
    };

/**
 * 「文件系统…」懒加载子树（工作区之外也能选附件）。
 *
 * 节点级状态：每次展开是独立异步任务，A 的迟到响应只会迟到地填 A 节点——
 * 结构上不存在旧实现的「全局代际号防整列表串台」。
 *
 * @param api RPC 客户端
 * @returns 节点状态表与 load
 */
function useLazyFsFiles(api: ApiClient): {
  nodes: Record<string, LazyNode>;
  load: (key: string) => Promise<void>;
} {
  const [nodes, setNodes] = React.useState<Record<string, LazyNode>>({});
  const load = async (key: string): Promise<void> => {
    setNodes((prev) => ({
      ...prev,
      [key]: { children: prev[key]?.children ?? null, files: prev[key]?.files ?? new Set(), loading: true, error: null },
    }));
    const path = fsPathOf(key) ?? undefined;
    try {
      const r: BrowseWithFiles = await api.browseFs(path, true);
      const [children, files] = resultOf(key, r);
      setNodes((prev) => ({
        ...prev,
        [key]: { children, files, loading: false, error: null },
      }));
    } catch (e) {
      setNodes((prev) => ({
        ...prev,
        [key]: {
          children: prev[key]?.children ?? null,
          files: prev[key]?.files ?? new Set(),
          loading: false,
          error: (e as Error).message,
        },
      }));
    }
  };
  return { nodes, load };
}

/**
 * 把一次 `fs.browse` 回包映射成懒加载子节点。
 * @param key 父节点 key
 * @param r 回包
 * @returns [子节点, 该层文件 key 集]
 */
function resultOf(key: string, r: BrowseWithFiles): [TreeDataNode[], Set<string>] {
  const files = new Set<string>();
  if (r.level === 'drives') {
    const roots = Array.isArray(r.roots) ? r.roots : [];
    const home = typeof r.home === 'string' ? r.home : '';
    const children: TreeDataNode[] = roots.map((root) => ({
      key: fsKeyOf(root),
      title: lazyTitle('dir', root),
      isLeaf: false,
    }));
    if (home !== '') {
      children.unshift({
        key: fsKeyOf(home),
        title: lazyTitle('dir', `${home}${t('（用户目录）')}`),
        isLeaf: false,
      });
    }
    return [children, files];
  }
  if (r.level !== 'dir' || !Array.isArray(r.dirs)) {
    throw new Error(t('文件列表返回格式异常（fs.browse）'));
  }
  const base = r.path ?? (fsPathOf(key) ?? '');
  const children: TreeDataNode[] = [
    ...r.dirs.map((dir) => ({
      key: fsKeyOf(joinPath(base, dir)),
      title: lazyTitle('dir', dir),
      isLeaf: false,
    })),
    ...(Array.isArray(r.files) ? r.files : []).map((file) => {
      const full = fsKeyOf(joinPath(base, file.name));
      files.add(full);
      return {
        key: full,
        title: lazyTitle('file', file.name, FileSizeFormatter.human(file.size)),
        isLeaf: true,
      };
    }),
  ];
  return [children, files];
}

/**
 * 拼接路径（懒加载层不信任后端 parent，按 base + name 拼）。
 * @param base 目录
 * @param name 名字
 * @returns 路径
 */
function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

/**
 * 懒加载节点的标题（文件带体积）。
 * @param kind 目录/文件
 * @param name 名字
 * @param size 体积文案（可选）
 * @returns 标题节点
 */
function lazyTitle(kind: 'dir' | 'file', name: string, size?: string): React.ReactNode {
  return (
    <span className="fp-node">
      <span className="fp-node-icon" aria-hidden="true">
        {icon(kind === 'dir' ? 'folder' : fileIconOf(name), { size: 14 })}
      </span>
      <span className="fp-node-name">{name}</span>
      {size === undefined ? null : <span className="fp-node-size">{size}</span>}
    </span>
  );
}

/**
 * 懒加载节点的子节点（加载中 / 错误+重试 / 空目录 的占位行）。
 * @param key 节点 key
 * @param node 该节点状态
 * @param onRetry 重试回调
 * @returns 子节点数组
 */
function lazyChildrenOf(
  key: string,
  node: LazyNode | undefined,
  onRetry: (key: string) => void,
): TreeDataNode[] {
  if (node === undefined) return [];
  if (node.error !== null) {
    return [
      {
        key: `${key}#err`,
        selectable: false,
        checkable: false,
        title: (
          <span className="fp-tree-error">
            {node.error}
            <button
              type="button"
              className="fp-retry"
              onClick={(e) => {
                e.stopPropagation();
                onRetry(key);
              }}
            >
              {t('重试')}
            </button>
          </span>
        ),
      },
    ];
  }
  if (node.loading) {
    return [
      {
        key: `${key}#loading`,
        selectable: false,
        checkable: false,
        title: <span className="fp-tree-loading">{t('读取中…')}</span>,
      },
    ];
  }
  if (node.children !== null && node.children.length === 0) {
    return [
      {
        key: `${key}#empty`,
        selectable: false,
        checkable: false,
        title: <span className="fp-tree-empty">{t('（空目录）')}</span>,
      },
    ];
  }
  return node.children ?? [];
}

/**
 * 把已加载的懒节点子级**递归**挂回树上（父节点每帧现拼，不回填的话深层目录永远挂不上）。
 * @param nodes 待挂的节点
 * @param nodesState 节点状态表
 * @param onRetry 重试回调
 * @returns 挂好子级的新数组
 */
function attachLazy(
  nodes: TreeDataNode[],
  nodesState: Record<string, LazyNode>,
  onRetry: (key: string) => void,
): TreeDataNode[] {
  return nodes.map((node) => {
    const key = String(node.key);
    const state = nodesState[key];
    if (!isFsKey(key) || state === undefined) return node;
    return { ...node, children: attachLazy(lazyChildrenOf(key, state, onRetry), nodesState, onRetry) };
  });
}

/**
 * 选择器主体：过滤条 + 树 + 页脚。
 * @param props 数据态、过滤值、展开/勾选集与回调
 * @returns 主体节点
 */
/**
 * 树 + 预览两栏。
 * @param props 数据态、选择态、懒加载子树、预览与回调
 * @returns 两栏节点
 */
function TreeSplit(props: {
  state: TreeState;
  expanded: React.Key[];
  checked: React.Key[];
  visible: FsNode[];
  fsNode: TreeDataNode[];
  preview: PreviewState | null;
  onExpand: (keys: React.Key[]) => void;
  onCheck: (keys: React.Key[], key: string, checked: boolean) => void;
}): ReactElement {
  const { state, visible } = props;
  const fsRoot: TreeDataNode = {
    key: FS_ROOT,
    checkable: false,
    isLeaf: false,
    title: (
      <span className="fp-node fp-node-fs">
        <span className="fp-node-icon" aria-hidden="true">
          {icon('drive', { size: 14 })}
        </span>
        <span className="fp-node-name">{t('文件系统…')}</span>
      </span>
    ),
    children: props.fsNode,
  };
  return (
    <div className={'fp-split' + (props.preview === null ? '' : ' has-preview')}>
      <div className="fp-list fp-tree">
        {state.loading ? <div className="fp-empty">{t('读取中…')}</div> : null}
        {!state.loading && state.error !== null ? <div className="fp-err">{state.error}</div> : null}
        {!state.loading && state.error === null && state.tree.length === 0 ? (
          <div className="fp-empty">{t('工作区还没有文件')}</div>
        ) : null}
        {!state.loading && state.error === null && visible.length === 0 && state.tree.length > 0 ? (
          <div className="fp-empty">{t('没有匹配的文件')}</div>
        ) : null}
        {/* 树**始终**渲染：工作区为空或过滤无命中时，「文件系统…」仍要可用。 */}
        {state.loading ? null : (
          <Tree
            checkable
            selectable={false}
            height={320}
            treeData={[...visible.map(toTreeNode), fsRoot]}
            expandedKeys={props.expanded}
            checkedKeys={props.checked}
            onExpand={props.onExpand}
            onCheck={(keys, info) =>
              props.onCheck(
                Array.isArray(keys) ? keys : keys.checked,
                String(info.node.key),
                info.checked === true,
              )
            }
          />
        )}
      </div>
      {props.preview === null ? null : (
        <PreviewPane
          preview={props.preview}
          name={props.preview.path.split(/[\\/]/).pop() ?? props.preview.path}
        />
      )}
    </div>
  );
}

function FilePickerBody(props: {
  state: TreeState;
  query: string;
  expanded: React.Key[];
  checked: React.Key[];
  visible: FsNode[];
  /** 「文件系统…」根节点的子节点（懒加载，工作区外也能选附件）。 */
  fsNode: TreeDataNode[];
  /** 预览窗格（P3；null = 不显示）。 */
  preview: PreviewState | null;
  onQuery: (value: string) => void;
  onExpand: (keys: React.Key[]) => void;
  onCheck: (keys: React.Key[], key: string, checked: boolean) => void;
  onRefresh: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { state, query, expanded, checked, visible } = props;
  const checkedCount = checked.length;
  return (
    <>
      <div className="fp-treebar">
        {/* 原生 input 而非 antd Input：`antd/es/input` 属于 panel-antd 异步块，
            在选择器里静态引用会把该块拖回首屏（vendorFreePipeline 实测拦截）。 */}
        <input
          className="fp-filter"
          type="text"
          value={query}
          placeholder={t('过滤已加载的文件…')}
          aria-label={t('过滤文件')}
          onChange={(e) => props.onQuery(e.target.value)}
        />
        <span className="fp-selected-count">
          {checkedCount > 0 ? t('已选 {count} 个', { count: checkedCount }) : ''}
        </span>
        <button type="button" className="fp-btn fp-refresh" onClick={props.onRefresh}>
          {t('刷新')}
        </button>
      </div>
      <TreeSplit
        state={state}
        expanded={expanded}
        checked={checked}
        visible={visible}
        fsNode={props.fsNode}
        preview={props.preview}
        onExpand={props.onExpand}
        onCheck={props.onCheck}
      />
      <div className="fp-actions">
        <button className="fp-btn" onClick={props.onCancel}>
          {t('取消')}
        </button>
        <button
          className="fp-btn fp-primary"
          disabled={checkedCount === 0}
          onClick={props.onConfirm}
        >
          {checkedCount > 0 ? t('添加 {count} 个文件', { count: checkedCount }) : t('添加文件')}
        </button>
      </div>
    </>
  );
}

/** 预览窗格状态（P3：勾选/激活即预览，单选语义）。 */
interface PreviewState {
  path: string;
  loading: boolean;
  text: string | null;
  binary: boolean;
  error: string | null;
}

/**
 * 文件预览（P3）：读前 40 行；二进制只说明不硬解，错误如实显示。
 *
 * 用请求序号丢弃过期响应——快速连点两个文件时，先发的慢响应不得覆盖后选的那个。
 *
 * @param api RPC 客户端
 * @returns 预览态与 show
 */
function useFilePreview(api: ApiClient): {
  preview: PreviewState | null;
  show: (path: string) => void;
} {
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const seq = React.useRef(0);
  const show = (path: string): void => {
    const mine = ++seq.current;
    setPreview({ path, loading: true, text: null, binary: false, error: null });
    // fail-closed：老桩/未接线后端没有 fs.read 时，预览给明确提示，绝不抛未处理异常
    //（2026-10-30：其它用例的 api 桩没这个方法，无守卫时会变成 unhandled rejection）。
    const read = typeof api.readFs === 'function' ? api.readFs.bind(api) : null;
    if (read === null) {
      setPreview({
        path,
        loading: false,
        text: null,
        binary: false,
        error: t('预览不可用（fs.read 未接线）'),
      });
      return;
    }
    void read(path)
      .then((r) => {
        if (mine !== seq.current) return;
        if (r.isBinary === true) {
          setPreview({ path, loading: false, text: null, binary: true, error: null });
          return;
        }
        const text = (r.content ?? '').split('\n').slice(0, 40).join('\n');
        setPreview({ path, loading: false, text, binary: false, error: null });
      })
      .catch((e: Error) => {
        if (mine !== seq.current) return;
        setPreview({ path, loading: false, text: null, binary: false, error: e.message });
      });
  };
  return { preview, show };
}

/**
 * 预览窗格。
 * @param props 预览态与文件名
 * @returns 预览节点
 */
function PreviewPane(props: { preview: PreviewState; name: string }): ReactElement {
  const { preview } = props;
  return (
    <aside className="fp-preview" aria-label={t('文件预览')}>
      <div className="fp-preview-head" title={preview.path}>
        {props.name}
      </div>
      <div className="fp-preview-body">
        {preview.loading ? <div className="fp-tree-loading">{t('读取中…')}</div> : null}
        {!preview.loading && preview.error !== null ? (
          <div className="fp-err">{t('读取预览失败：{msg}', { msg: preview.error })}</div>
        ) : null}
        {!preview.loading && preview.binary ? (
          <div className="fp-tree-empty">{t('二进制文件（不显示内容）')}</div>
        ) : null}
        {!preview.loading && preview.text !== null ? (
          <pre className="fp-preview-text">{preview.text}</pre>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 文件选择器：工作区整树 → 勾选文件 → 确认回传绝对路径列表。
 * @param props 组件入参
 * @returns 文件选择弹窗节点
 */
/** 选中与展开态（FilePicker 的逻辑段抽出）：过滤、懒文件集、展开联动、勾选预览与确认。 */
function useFilePickerSelection(
  state: ReturnType<typeof useWorkspaceTree>,
  lazy: ReturnType<typeof useLazyFsFiles>,
  filePreview: ReturnType<typeof useFilePreview>,
  query: string,
  composing: React.RefObject<boolean>,
  onPick: (paths: string[]) => void,
): {
  readonly expanded: React.Key[];
  readonly checked: React.Key[];
  readonly visible: FsNode[];
  readonly onExpand: (keys: React.Key[]) => void;
  readonly onCheck: (keys: React.Key[], key: string, checkedNow: boolean) => void;
  readonly confirm: () => void;
} {
  const [expanded, setExpanded] = React.useState<React.Key[]>([FS_ROOT]);
  const [checked, setChecked] = React.useState<React.Key[]>([]);
  const visible = React.useMemo(() => filterFs(state.tree, query), [state.tree, query]);
  const filePaths = React.useMemo(() => new Set(fileKeysOf(state.tree)), [state.tree]);
  /** 懒加载层已加载出的文件 key（勾选闸用：懒目录的 key 也会出现在 checkedKeys 里）。 */
  const lazyFiles = React.useMemo(() => {
    const out = new Set<string>();
    for (const node of Object.values(lazy.nodes)) for (const key of node.files) out.add(key);
    return out;
  }, [lazy.nodes]);

  // 过滤变化时把命中路径的目录全部展开（否则过滤命中在折叠里看不见），但**保留懒加载子树的展开态**；
  // IME 组合期不重算（避免拼音中间态把树展开态抖掉）。
  React.useEffect(() => {
    if (composing.current === true) return;
    setExpanded((prev) => [
      ...prev.filter((key) => isFsKey(String(key))),
      ...(query === '' ? [] : dirKeysOf(visible)),
    ]);
  }, [query, visible]);

  /** 展开：懒加载节点首次展开时触发该节点自己的加载。 */
  const onExpand = (keys: React.Key[]): void => {
    setExpanded(keys);
    for (const key of keys) {
      const k = String(key);
      if (isFsKey(k) && lazy.nodes[k] === undefined) void lazy.load(k);
    }
  };

  /** 勾选：只收文件 key（工作区路径或懒加载文件），父目录的半选由 antd 自己画；勾上即预览。 */
  const onCheck = (keys: React.Key[], key: string, checkedNow: boolean): void => {
    setChecked(keys.filter((k) => filePaths.has(String(k)) || lazyFiles.has(String(k))));
    if (checkedNow) filePreview.show(fsPathOf(key) ?? key);
  };

  /** 确认：至少选一个文件才回传；懒加载 key 去掉 `fs:` 前缀还原成绝对路径。 */
  const confirm = (): void => {
    if (checked.length === 0) return;
    onPick(checked.map((key) => fsPathOf(String(key)) ?? String(key)));
  };

  return { expanded, checked, visible, onExpand, onCheck, confirm };
}

/**
 * 选择附件文件弹窗（工作区整树 + 懒加载「文件系统…」子树 + 勾选即预览）。
 * @param props 组件属性。
 * @returns 弹窗节点。
 */
export function FilePicker(props: FilePickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const state = useWorkspaceTree(api);
  const lazy = useLazyFsFiles(api);
  const filePreview = useFilePreview(api);
  const [query, setQuery] = React.useState<string>('');
  const composing = React.useRef(false);

  // Esc 关闭（依赖写全：onCancel 变化即重挂，handler 恒为最新闭包）。
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  // 「文件系统…」首开即展开一层（盘符）：工作区外的附件路径一眼可见。
  React.useEffect(() => {
    void lazy.load(FS_ROOT);
  }, []);

  // 选中与展开态（逻辑段抽到 useFilePickerSelection：勾选过滤/懒加载展开/勾选预览/确认）。
  const { expanded, checked, visible, onExpand, onCheck, confirm } = useFilePickerSelection(
    state,
    lazy,
    filePreview,
    query,
    composing,
    onPick,
  );

  const fsNode = attachLazy(
    lazyChildrenOf(FS_ROOT, lazy.nodes[FS_ROOT], (k) => void lazy.load(k)),
    lazy.nodes,
    (k) => void lazy.load(k),
  );

  return (
    <PickerModal title={t('选择附件文件')} onCancel={onCancel}>
      <div
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      >
        <FilePickerBody
          state={state}
          query={query}
          expanded={expanded}
          checked={checked}
          visible={visible}
          fsNode={fsNode}
          preview={filePreview.preview}
          onQuery={setQuery}
          onExpand={onExpand}
          onCheck={onCheck}
          onRefresh={state.refresh}
          onCancel={onCancel}
          onConfirm={confirm}
        />
      </div>
    </PickerModal>
  );
}
