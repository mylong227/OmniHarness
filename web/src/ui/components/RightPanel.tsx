// 右栏容器：标签页入口 + 当前激活面板插槽。各具体面板由 App 根据 activePane 选择后作为 children 注入，
// 本组件只负责标签切换与移动端抽屉态，不做业务逻辑。

import { React } from '../deps.js';

export interface RightPanelProps {
  activePane: string;
  onSelect: (pane: string) => void;
  open: boolean;
  children: ReactNode;
  style?: Record<string, string>;
}

interface TabItem {
  readonly key: string;
  readonly label: string;
}

const TABS: readonly TabItem[] = [
  { key: 'tools', label: '工具' },
  { key: 'changes', label: '变更' },
  { key: 'metrics', label: '指标' },
  { key: 'settings', label: '设置' },
  { key: 'plugins', label: '插件' },
  { key: 'graph', label: '编排' },
  { key: 'memory', label: '记忆' },
  { key: 'profiles', label: '配置集' },
  { key: 'file', label: '文件' },
  { key: 'detail', label: '⤢ 钻取' },
];

/** 右栏容器组件。 */
export class RightPanel extends React.Component<RightPanelProps> {
  private renderTab(t: TabItem): ReactElement {
    const { activePane, onSelect } = this.props;
    return (
      <div
        key={t.key}
        className={'tab' + (t.key === activePane ? ' active' : '')}
        onClick={() => onSelect(t.key)}
      >
        {t.label}
      </div>
    );
  }

  override render(): ReactElement {
    const { open, children, style } = this.props;
    return (
      <div className={'col right' + (open ? ' open' : '')} style={style}>
        <div className="tabs">{TABS.map((t) => this.renderTab(t))}</div>
        <div className="pane active">{children}</div>
      </div>
    );
  }
}
