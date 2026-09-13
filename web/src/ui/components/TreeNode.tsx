// 文件树节点：目录节点自己管理展开态（惰性，展开时才渲染子节点）；文件节点点击即打开。
// 面向对象改造：展开态从 useState 改为 this.state，递归渲染保持不变。

import { React } from '../deps.js';
import { AppComponent } from '../base/AppComponent.js';
import type { FsNode } from '../../types/models.js';

export interface TreeNodeProps {
  node: FsNode;
  onOpenFile: (path: string) => void;
}

interface TreeNodeState {
  open: boolean;
}

/** 文件树节点组件。 */
export class TreeNode extends AppComponent<TreeNodeProps, TreeNodeState> {
  constructor(props: TreeNodeProps) {
    super(props);
    this.state = { open: false };
  }

  private readonly toggle = (): void => {
    this.setState((prev) => ({ open: !prev.open }));
  };

  override render(): ReactElement {
    const { node, onOpenFile } = this.props;
    if (node.type === 'dir') {
      const { open } = this.state;
      const children = open ? node.children || [] : [];
      return (
        <div className={'node dir' + (open ? ' open' : '')}>
          <span className="label" onClick={this.toggle}>
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
}
