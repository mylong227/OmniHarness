// 左栏外壳开合态的类型（图标条 / 文件区 / 项目下拉）。
//
// 为什么单独成文件：实现 `useSidebarChrome` 必须留在 SessionPanel.tsx（`[` 快捷键与 Esc 关菜单
// 被 web/test/sessionTimeGrouping.test.ts 的接线守卫按源码锚点钉住），而 `SessionPanelHead` /
// `SessionPanelBody` 都要读这组状态——把类型放这里，两边都只依赖一个纯接口，不产生运行时环。

/** 左栏自身开合态与动作。 */
export interface SidebarChrome {
  /** 左栏是否收成图标条（业界常见式可折叠侧栏；快捷键 `[`）。 */
  readonly rail: boolean;
  /** 文件区是否展开。 */
  readonly treeOpen: boolean;
  /** 顶部项目下拉是否展开。 */
  readonly wsMenuOpen: boolean;
  /** 展开左栏（点搜索 / 项目条时从图标条拉回）。 */
  readonly expandRail: () => void;
  /** 折叠 / 展开文件区（图标条态点区块头 = 展开侧栏并进入该区块）。 */
  readonly toggleTree: () => void;
  /** 翻转项目下拉。 */
  readonly toggleWsMenu: () => void;
  /** 收起项目下拉。 */
  readonly closeWsMenu: () => void;
}
