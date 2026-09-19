// 右栏容器：标签页入口 + 当前激活面板插槽。各具体面板由 App 根据 activePane 选择后作为 children 注入，
// 本组件只负责标签切换与移动端抽屉态，不做业务逻辑。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { React } from '../deps.js';

/** RightPanel 组件的入参。 */
export interface RightPanelProps {
  /** 当前激活的面板标识。 */
  activePane: string;
  /** 切换面板。 */
  onSelect: (pane: string) => void;
  /** 右栏是否展开（移动端抽屉态）。 */
  open: boolean;
  /** 当前面板内容（由 App 按 activePane 选择后注入）。 */
  children: ReactNode;
  /** 移动端内联样式覆盖。 */
  style?: Record<string, string>;
}

/** 右栏标签项。 */
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

/**
 * 右栏容器：渲染标签条与当前面板内容。
 * @param props 组件入参
 * @returns 右栏节点
 */
export function RightPanel(props: RightPanelProps): ReactElement {
  const { activePane, onSelect, open, children, style } = props;
  /** 渲染单个标签：选中态由 activePane 决定。 */
  const renderTab = (t: TabItem): ReactElement => (
    <div
      key={t.key}
      className={'tab' + (t.key === activePane ? ' active' : '')}
      onClick={() => onSelect(t.key)}
    >
      {t.label}
    </div>
  );
  return (
    <div className={'col right' + (open ? ' open' : '')} style={style}>
      <div className="tabs">{TABS.map((t) => renderTab(t))}</div>
      <div className="pane active">{children}</div>
    </div>
  );
}
