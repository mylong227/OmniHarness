// 文件夹选择器（+ 添加项目）—— 2026-10-30 重设计 P2（docs/PICKER_REDESIGN_2026-10-30.md §4.2/§4.3）。
//
// 双源供给，同一棵树：
//   · 工作区内 = 一次 `fs.list` 整棵工作区树（目录可选、文件置灰）；
//   · 工作区外 = 「文件系统…」根节点下的**节点级懒加载**（展开一个目录 = 一次 `fs.browse`），
//     结果填进该节点的 children。慢盘上 A 节点的迟到响应只可能迟到地填 A 节点，
//     结构上不存在旧实现「全局代际号防整列表串台」那类竞态。
//
// 与 P1 的 FilePicker 共用交互纪律，但**不共用组件实例**（设计 §10）：FolderPicker 单选、
// 无复选框；单击目录 = 选中，展开由切换器负责；`选择此文件夹` 显式确认。
//
// 保留契约：`PickerModal` 的 Esc 关闭与焦点归还；「新建文件夹」（在当前选中目录内建，建完即返回）；
// `fs.browse` 形状不合法 ⇒ 节点级错误文案，不把 undefined 灌进 state。

import * as React from 'react';
import { Tree } from 'antd';
import type { TreeDataNode } from 'antd';
import { PathJoiner } from '../models/PathJoiner.ts';
import { PickerKeys } from '../models/PickerKeys.ts';
import { icon } from '../models/Icon.ts';
import { FS_ROOT, fsKeyOf, fsPathOf, isFsKey } from '../models/FsPickerLazy.ts';
import { PickerModal } from './PickerModal.tsx';
import type { ApiClient } from '../../core/ApiClient.ts';
import type { FsNode } from '../../types/models.ts';
import { t } from '../i18n/i18n.ts';

/** 工作区 `fs.list` 深度。 */
const DEPTH = 3;

/** `fs.browse` 的回包（目录层只关心 dirs）。 */
type BrowseResult =
  | { level: 'drives'; roots: string[]; home: string }
  | { level: 'dir'; path: string; parent?: string; dirs: string[] };

/** FolderPicker 组件的入参。 */
export interface FolderPickerProps {
  /** ApiClient（fs.list / fs.browse / fs.mkdir）。 */
  api: ApiClient;
  /** 取消选择（关闭弹窗）。 */
  onCancel: () => void;
  /** 确认选择：传入选中目录的绝对路径。 */
  onPick: (path: string) => void;
}

/** 懒加载节点的状态（键 = 树 key）。 */
interface LazyState {
  /** null = 尚未加载。 */
  children: TreeDataNode[] | null;
  loading: boolean;
  error: string | null;
}

/** 新建文件夹态。 */
interface CreateState {
  creating: boolean;
  newName: string;
  creatingErr: string | null;
}

/** 新建文件夹的默认名称（用户可直接回车确认）。 */
const DEFAULT_NEW_NAME = '新项目';

/**
 * 工作区节点标题：目录 / 文件共用（文件置灰，仅作上下文可见）。
 * @param node 文件树节点
 * @returns 标题节点
 */
function titleOf(node: FsNode): React.ReactNode {
  return (
    <span className={'fp-node' + (node.type === 'file' ? ' fp-node-file' : '')}>
      <span className="fp-node-icon" aria-hidden="true">
        {icon(node.type === 'dir' ? 'folder' : 'file', { size: 14 })}
      </span>
      <span className="fp-node-name">{node.name}</span>
    </span>
  );
}

/**
 * 工作区 `FsNode` → treeData（文件不可选，只作上下文）。
 * @param node 文件树节点
 * @returns treeData 节点
 */
function wsNode(node: FsNode): TreeDataNode {
  const children = node.children?.map(wsNode);
  return {
    key: node.path,
    title: titleOf(node),
    isLeaf: node.type === 'file',
    selectable: node.type === 'dir',
    ...(node.type === 'file' ? { disabled: true } : {}),
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  };
}

/**
 * 读工作区整树（失败也不挡「文件系统…」懒加载模式，见设计 §6）。
 * @param api RPC 客户端
 * @returns 树、加载态、错误与 refresh
 */
function useWorkspaceTree(api: ApiClient): {
  tree: FsNode[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [state, setState] = React.useState<{ tree: FsNode[]; loading: boolean; error: string | null }>({
    tree: [],
    loading: true,
    error: null,
  });
  const seq = React.useRef(0);
  const load = React.useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const r = await api.listFs(DEPTH);
      if (mine !== seq.current) return;
      setState({
        tree: Array.isArray(r?.tree) ? r.tree : [],
        loading: false,
        error: Array.isArray(r?.tree) ? null : t('文件树返回格式异常（fs.list）'),
      });
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
 * 懒加载子树：展开 `fs:` 根 → 列盘符；展开盘符/目录 → 列子目录。
 * 每个节点的状态独立（节点级错误 + 重试），不存在跨节点串台。
 *
 * @param api RPC 客户端
 * @returns 节点状态表与 loadNode
 */
function useLazyFs(api: ApiClient): {
  nodes: Record<string, LazyState>;
  load: (key: string) => Promise<void>;
} {
  const [nodes, setNodes] = React.useState<Record<string, LazyState>>({});
  const load = async (key: string): Promise<void> => {
    setNodes((prev) => ({
      ...prev,
      [key]: { children: prev[key]?.children ?? null, loading: true, error: null },
    }));
    const path = fsPathOf(key) ?? undefined;
    try {
      const r: BrowseResult = await api.browseFs(path);
      let children: TreeDataNode[];
      if (r.level === 'drives') {
        const roots = Array.isArray(r.roots) ? r.roots : [];
        const home = typeof r.home === 'string' ? r.home : '';
        children = [
          ...(home === ''
            ? []
            : [{ key: fsKeyOf(home), title: titleOf({ name: `${home}${t('（用户目录）')}`, path: home, type: 'dir' }), isLeaf: false }]),
          ...roots.map((root) => ({
            key: fsKeyOf(root),
            title: titleOf({ name: root, path: root, type: 'dir' }),
            isLeaf: false,
          })),
        ];
      } else if (r.level === 'dir' && Array.isArray(r.dirs)) {
        const base = r.path ?? path ?? '';
        children = r.dirs.map((dir) => ({
          key: fsKeyOf(PathJoiner.join(base, dir)),
          title: titleOf({ name: dir, path: PathJoiner.join(base, dir), type: 'dir' }),
          isLeaf: false,
        }));
      } else {
        throw new Error(t('目录列表返回格式异常（fs.browse）'));
      }
      setNodes((prev) => ({ ...prev, [key]: { children, loading: false, error: null } }));
    } catch (e) {
      setNodes((prev) => ({
        ...prev,
        [key]: { children: prev[key]?.children ?? null, loading: false, error: (e as Error).message },
      }));
    }
  };
  return { nodes, load };
}

/**
 * 把一个懒加载节点的状态合成为 treeData：加载中 / 错误 + 重试 / 空目录。
 * @param key 节点 key
 * @param lazy 该节点状态
 * @param onRetry 重试回调
 * @returns 子节点数组
 */
function lazyChildrenOf(
  key: string,
  lazy: LazyState | undefined,
  onRetry: (key: string) => void,
): TreeDataNode[] {
  if (lazy === undefined) return [];
  if (lazy.error !== null) {
    return [
      {
        key: `${key}#err`,
        selectable: false,
        title: (
          <span className="fp-tree-error">
            {lazy.error}
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
  if (lazy.loading) {
    return [{ key: `${key}#loading`, selectable: false, title: <span className="fp-tree-loading">{t('读取中…')}</span> }];
  }
  if (lazy.children !== null && lazy.children.length === 0) {
    return [{ key: `${key}#empty`, selectable: false, title: <span className="fp-tree-empty">{t('（空目录）')}</span> }];
  }
  return lazy.children ?? [];
}

/**
 * 拼树：工作区子树 + 文件系统懒加载子树。
 * @param wsNodes 工作区 treeData
 * @param fsRoot 「文件系统…」根节点
 * @returns 完整 treeData
 */
function buildTreeData(
  wsNodes: TreeDataNode[],
  fsRoot: TreeDataNode,
): TreeDataNode[] {
  return [...wsNodes, fsRoot];
}

/**
 * 「文件系统…」根节点（标题 + 懒加载子节点）。
 * @param lazy 该节点状态
 * @param onRetry 重试回调
 * @returns treeData 节点
 */
function fsRootNode(
  lazy: LazyState | undefined,
  onRetry: (key: string) => void,
): TreeDataNode {
  return {
    key: FS_ROOT,
    title: (
      <span className="fp-node fp-node-fs">
        <span className="fp-node-icon" aria-hidden="true">
          {icon('drive', { size: 14 })}
        </span>
        <span className="fp-node-name">{t('文件系统…')}</span>
      </span>
    ),
    isLeaf: false,
    children: lazyChildrenOf(FS_ROOT, lazy, onRetry),
  };
}

/**
 * 新建文件夹输入区。
 * @param props 目标路径、新建态与三个回调
 * @returns 新建区节点
 */
function CreateBar(props: {
  path: string;
  state: CreateState;
  onChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}): ReactElement {
  const { path, state } = props;
  return (
    <div className="fp-create">
      <span className="fp-create-label">{t('在 {path} 内新建：', { path })}</span>
      <div className="fp-create-row">
        <input
          className="fp-input"
          value={state.newName}
          placeholder={t('文件夹名称')}
          autoFocus
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select()}
          onInput={(e: React.SyntheticEvent) =>
            props.onChange((e.target as HTMLInputElement).value)
          }
          onKeyDown={(e: React.KeyboardEvent) => {
            const composing = (e.nativeEvent as KeyboardEvent).isComposing === true;
            if (PickerKeys.resolve(e.key, { creating: true, composing }) === 'confirm-create') {
              e.preventDefault();
              props.onCreate();
            }
          }}
        />
        <button className="fp-btn fp-primary" onClick={props.onCreate}>
          {t('创建')}
        </button>
        <button className="fp-btn" onClick={props.onCancel}>
          {t('取消')}
        </button>
      </div>
      {state.creatingErr === null ? null : <div className="fp-err">{state.creatingErr}</div>}
    </div>
  );
}

/**
 * 把已加载的懒节点子级**递归**挂回树上。
 *
 * 为什么需要：`load` 只把结果写进 `nodes[key]`，而父节点是每帧现拼的 treeData——
 * 不递归回填的话，展开盘符后它自己的子目录永远挂不上（首版漏了这步，P2 判据当场红）。
 *
 * @param nodes 待挂的节点
 * @param nodesState 节点状态表
 * @param onRetry 重试回调
 * @returns 挂好子级的新数组
 */
function attachLazy(
  nodes: TreeDataNode[],
  nodesState: Record<string, LazyState>,
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
 * 选择器主体：路径栏 + 树 + 页脚。
 * @param props 树数据、选择态与回调
 * @returns 主体节点
 */
function FolderPickerBody(props: {
  loading: boolean;
  error: string | null;
  treeData: TreeDataNode[];
  expanded: React.Key[];
  selected: string | null;
  create: CreateState;
  onCreateChange: (value: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onExpand: (keys: React.Key[]) => void;
  onSelect: (keys: React.Key[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const selectedPath = props.selected;
  return (
    <>
      <div className="fp-treebar">
        <span className="fp-crumb" title={selectedPath ?? ''}>
          {selectedPath ?? t('未选择目录')}
        </span>
        <button
          className="fp-new"
          title={t('在当前目录内新建项目文件夹')}
          disabled={selectedPath === null}
          onClick={props.onCreate}
        >
          {t('新建文件夹')}
        </button>
      </div>
      <div className="fp-list fp-tree">
        {props.create.creating ? (
          <CreateBar
            path={selectedPath ?? ''}
            state={props.create}
            onChange={props.onCreateChange}
            onCreate={props.onCreate}
            onCancel={props.onCancelCreate}
          />
        ) : null}
        {props.loading ? <div className="fp-empty">{t('读取中…')}</div> : null}
        {!props.loading && props.error !== null ? <div className="fp-err">{props.error}</div> : null}
        <Tree
          selectable
          height={320}
          treeData={props.treeData}
          expandedKeys={props.expanded}
          selectedKeys={selectedPath === null ? [] : [selectedPath]}
          onExpand={props.onExpand}
          onSelect={props.onSelect}
        />
      </div>
      <div className="fp-actions">
        <button className="fp-btn" onClick={props.onCancel}>
          {t('取消')}
        </button>
        <button
          className="fp-btn fp-primary"
          disabled={selectedPath === null}
          onClick={props.onConfirm}
        >
          {t('选择此文件夹')}
        </button>
      </div>
    </>
  );
}

/**
 * 目录选择器：工作区树 + 「文件系统…」懒加载子树，单选目录后显式确认。
 * @param props 组件入参
 * @returns 目录选择弹窗节点
 */
export function FolderPicker(props: FolderPickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const ws = useWorkspaceTree(api);
  const lazy = useLazyFs(api);
  const [expanded, setExpanded] = React.useState<React.Key[]>([FS_ROOT]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [create, setCreate] = React.useState<CreateState>({
    creating: false,
    newName: '',
    creatingErr: null,
  });

  // 首次进入就把「文件系统…」展开一层（盘符），让工作区外的路径也一眼可见。
  React.useEffect(() => {
    void lazy.load(FS_ROOT);
  }, []);

  // Esc 语义：新建态先退新建（就近取消），浏览态才关整个弹窗；其余按键一律放行（2026-10-07 教训）。
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = PickerKeys.resolve(e.key, { creating: create.creating, composing: e.isComposing });
      if (action === 'exit-create') {
        e.preventDefault();
        setCreate((prev) => ({ ...prev, creating: false, creatingErr: null }));
        return;
      }
      if (action === 'close-picker') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [create.creating, onCancel]);

  /**
   * 展开节点：懒加载节点首次展开时触发加载（已加载过则不再请求）。
   * @param keys 新的展开键集合
   */
  const onExpand = (keys: React.Key[]): void => {
    setExpanded(keys);
    for (const key of keys) {
      const k = String(key);
      if (isFsKey(k) && lazy.nodes[k] === undefined) void lazy.load(k);
    }
  };

  /** 选中目录（文件节点 disabled，不会走到这里）；懒加载节点顺手展开/加载。 */
  const onSelect = (keys: React.Key[]): void => {
    const key = keys[0] === undefined ? null : String(keys[0]);
    if (key === null || key === FS_ROOT) {
      setSelected(null);
      return;
    }
    setSelected(key);
    if (isFsKey(key) && lazy.nodes[key] === undefined) void lazy.load(key);
  };

  /** 当前选中目录的绝对路径（工作区节点 key 本身就是路径）。 */
  const selectedPath = selected === null ? null : isFsKey(selected) ? fsPathOf(selected) : selected;

  /** 新建文件夹：在选中的目录内建子目录，建完即作为项目返回。 */
  const createFolder = async (): Promise<void> => {
    if (selectedPath === null) return;
    const name = create.newName.trim();
    if (name === '') {
      setCreate((prev) => ({ ...prev, creatingErr: t('请输入文件夹名称') }));
      return;
    }
    setCreate((prev) => ({ ...prev, creatingErr: null }));
    try {
      const r = await api.mkdirFs(selectedPath, name);
      setCreate({ creating: false, newName: '', creatingErr: null });
      onPick(r.path);
    } catch (e) {
      setCreate((prev) => ({ ...prev, creatingErr: (e as Error).message }));
    }
  };

  const treeData = attachLazy(
    buildTreeData(ws.tree.map(wsNode), fsRootNode(lazy.nodes[FS_ROOT], (k) => void lazy.load(k))),
    lazy.nodes,
    (k) => void lazy.load(k),
  );
  return (
    <PickerModal title={t('选择项目文件夹')} onCancel={onCancel}>
      <FolderPickerBody
        loading={ws.loading}
        error={ws.error}
        treeData={treeData}
        expanded={expanded}
        selected={selected}
        create={create}
        onCreateChange={(value) => setCreate((prev) => ({ ...prev, newName: value }))}
        onCreate={() =>
          create.creating
            ? void createFolder()
            : setCreate({ creating: true, creatingErr: null, newName: t(DEFAULT_NEW_NAME) })
        }
        onCancelCreate={() => setCreate((prev) => ({ ...prev, creating: false, creatingErr: null }))}
        onExpand={onExpand}
        onSelect={onSelect}
        onCancel={onCancel}
        onConfirm={() => {
          if (selectedPath !== null) onPick(selectedPath);
        }}
      />
    </PickerModal>
  );
}
