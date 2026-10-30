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

/**
 * 选择器主体：过滤条 + 树 + 页脚。
 * @param props 数据态、过滤值、展开/勾选集与回调
 * @returns 主体节点
 */
function FilePickerBody(props: {
  state: TreeState;
  query: string;
  expanded: React.Key[];
  checked: React.Key[];
  visible: FsNode[];
  onQuery: (value: string) => void;
  onExpand: (keys: React.Key[]) => void;
  onCheck: (keys: React.Key[]) => void;
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
      <div className="fp-list fp-tree">
        {state.loading ? <div className="fp-empty">{t('读取中…')}</div> : null}
        {!state.loading && state.error !== null ? (
          <div className="fp-err">{state.error}</div>
        ) : null}
        {!state.loading && state.error === null && state.tree.length === 0 ? (
          <div className="fp-empty">{t('工作区还没有文件')}</div>
        ) : null}
        {!state.loading && state.error === null && visible.length > 0 ? (
          <Tree
            checkable
            selectable={false}
            height={320}
            treeData={visible.map(toTreeNode)}
            expandedKeys={expanded}
            checkedKeys={checked}
            onExpand={props.onExpand}
            onCheck={(keys) => props.onCheck(Array.isArray(keys) ? keys : keys.checked)}
          />
        ) : null}
        {!state.loading && state.error === null && visible.length === 0 && state.tree.length > 0 ? (
          <div className="fp-empty">{t('没有匹配的文件')}</div>
        ) : null}
      </div>
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

/**
 * 文件选择器：工作区整树 → 勾选文件 → 确认回传绝对路径列表。
 * @param props 组件入参
 * @returns 文件选择弹窗节点
 */
export function FilePicker(props: FilePickerProps): ReactElement {
  const { api, onCancel, onPick } = props;
  const state = useWorkspaceTree(api);
  const [query, setQuery] = React.useState<string>('');
  const [expanded, setExpanded] = React.useState<React.Key[]>([]);
  const [checked, setChecked] = React.useState<React.Key[]>([]);
  const composing = React.useRef(false);

  // Esc 关闭（依赖写全：onCancel 变化即重挂，handler 恒为最新闭包）。
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const visible = React.useMemo(() => filterFs(state.tree, query), [state.tree, query]);
  const filePaths = React.useMemo(() => new Set(fileKeysOf(state.tree)), [state.tree]);

  // 过滤变化时把命中路径的目录全部展开（否则过滤命中在折叠里看不见）；
  // IME 组合期不重算（避免拼音中间态把树展开态抖掉）。
  React.useEffect(() => {
    if (composing.current) return;
    setExpanded(query === '' ? [] : dirKeysOf(visible));
  }, [query, visible]);

  /** 勾选：只收文件路径（父目录的半选由 antd 自己画）。 */
  const onCheck = (keys: React.Key[]): void => {
    setChecked(keys.filter((key) => filePaths.has(String(key))));
  };

  /** 确认：至少选一个文件才回传。 */
  const confirm = (): void => {
    if (checked.length === 0) return;
    onPick(checked.map(String));
  };

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
          onQuery={setQuery}
          onExpand={setExpanded}
          onCheck={onCheck}
          onRefresh={state.refresh}
          onCancel={onCancel}
          onConfirm={confirm}
        />
      </div>
    </PickerModal>
  );
}
