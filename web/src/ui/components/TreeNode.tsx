// 文件树节点：目录节点自己管理展开态（惰性，展开时才渲染子节点）；文件节点点击即打开。
// 函数组件范式：递归渲染保持不变（函数组件可自引用），展开态用 useState。

import { React } from '../deps.js';
import type { FsNode } from '../../types/models.js';

/** TreeNode 组件的入参。 */
export interface TreeNodeProps {
  /** 当前节点（目录或文件）。 */
  node: FsNode;
  /** 点击文件节点时打开该路径。 */
  onOpenFile: (path: string) => void;
}

/**
 * 文件树节点：目录可展开 / 收起并递归渲染子节点；文件点击即打开。
 * @param props 组件入参
 * @returns 节点元素
 */
export function TreeNode(props: TreeNodeProps): ReactElement {
  const { node, onOpenFile } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  /** 展开 / 收起（函数式 updater，不依赖上次渲染捕获的 open）。 */
  const toggle = (): void => setOpen((prev) => !prev);

  if (node.type === 'dir') {
    // 惰性：仅展开时才渲染子节点，避免一次性铺开整棵树。
    const children = open ? node.children || [] : [];
    return (
      <div className={'node dir' + (open ? ' open' : '')}>
        <span className="label" onClick={toggle}>
          {node.name}
        </span>
        <div className="children">
          {children.map((c) => (
            <TreeNode key={c.path} node={c} onOpenFile={onOpenFile} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="node file">
      <span className="label" onClick={() => onOpenFile(node.path)}>
        {node.name}
      </span>
    </div>
  );
}
