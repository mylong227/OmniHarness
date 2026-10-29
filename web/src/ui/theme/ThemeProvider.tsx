// ThemeProvider：antd 运行时装配的唯一收口（ConfigProvider + AntApp + zhCN）。
//
// ## 为什么必须收口在一个组件（UI_LIBRARY_UPGRADE §6.2）
//
// locale / componentSize / ThemeConfig 若散在各组件的 ConfigProvider 里，
// 「改一次密度要动 N 处」会立刻回归成迁移前的碎片状态。规则：
//   · 全站只允许本组件出现 ConfigProvider / AntApp（W1 起加源码守卫）；
//   · theme 由 App 根的 themePref 解析结果传入（本组件不自持状态，便于判据驱动）；
//   · AntApp 提供 message/modal/notification 上下文（W3 的 Toast→message 迁移依赖它）；
//   · prefers-reduced-motion 的关闭在 CSS 层（antd.css）做，不在这里。
//
// ## 为什么只有**一层** ConfigProvider（W0 实测，别加层）
//
// 曾试过「外层 darkAlgorithm + 内层钉语义族」的双层方案：内层会**继承**外层算法，
// seed 照样被压暗，antd 没有「声明不用算法」的口子。最终形态是单层 + 两主题同走
// defaultAlgorithm + 中性面/语义 hover 全量显式（见 antdTheme.ts 文件头）。

import * as React from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { antdThemeOf } from './antdTheme.ts';
import type { ThemeName } from './palette.ts';

/** ThemeProvider 的入参。 */
export interface ThemeProviderProps {
  /** 已解析的主题（App 根持有 themePref，解析出 light/dark 后传入）。 */
  theme: ThemeName;
  children: React.ReactNode;
}

/**
 * antd 全局装配：locale=zhCN、紧凑密度、纸与墨 token、message/modal 上下文。
 * @param props theme + children
 * @returns 包裹后的节点
 */
export function ThemeProvider(props: ThemeProviderProps): React.ReactElement {
  return (
    <ConfigProvider
      locale={zhCN}
      componentSize="middle"
      theme={antdThemeOf(props.theme)}
    >
      <AntApp>{props.children}</AntApp>
    </ConfigProvider>
  );
}

