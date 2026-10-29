// 侧栏文件树：antd `Tree`（2026-10-29 W2）。
//
// 这里本来就是**真树形结构**（目录可展开、文件是叶子），所以直接交给组件库：
//   · 展开/收起、键盘导航（↑↓/→←/Home/End）、roving tabindex、可视区滚动由 antd 负责；
//   · 目录点击仍然「切换展开」（迁移前是点 label 展开），文件点击打开；
//   · 只渲染可见节点（rc-tree 的虚拟滚动），不会一次性铺开整棵大树。
//
// 数据形状 `FsNode` 不变：`key` 用绝对路径（同时是打开文件的参数），`isLeaf` 由 `type` 决定。

import * as React from 'react';
import { Tree } from 'antd';
import type { TreeDataNode } from 'antd';
import type { FsNode } from '../../types/models.ts';

/** FileTree 组件的入参。 */
export interface FileTreeProps {
  /** 工作区文件树（根节点数组）。 */
  nodes: readonly FsNode[];
  /** 点击文件节点时打开该路径。 */
  onOpenFile: (path: string) => void;
}

/**
 * 把 `FsNode` 递归映射成 antd Tree 的 treeData。
 * @param node 文件树节点
 * @returns antd TreeDataNode
 */
function toTreeData(node: FsNode): TreeDataNode {
  const children = node.children?.map(toTreeData);
  return {
    key: node.path,
    title: node.name,
    isLeaf: node.type === 'file',
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  };
}

/**
 * 侧栏文件树。
 * @param props 节点与打开回调
 * @returns 树节点
 */
export function FileTree(props: FileTreeProps): ReactElement {
  const { nodes, onOpenFile } = props;
  const treeData = React.useMemo(() => nodes.map(toTreeData), [nodes]);
  const [expanded, setExpanded] = React.useState<React.Key[]>([]);

  return (
    <Tree
      className="file-tree"
      treeData={treeData}
      expandedKeys={expanded}
      onExpand={(keys) => setExpanded(keys)}
      blockNode
      showIcon={false}
      onSelect={(keys, info) => {
        // 目录：点击标题即切换展开（迁移前的手感）；文件：选中即打开。
        const key = info.node.key;
        if (info.node.isLeaf === true) {
          if (info.selected) onOpenFile(String(key));
          return;
        }
        setExpanded((prev) =>
          prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
        );
        void keys;
      }}
    />
  );
}
