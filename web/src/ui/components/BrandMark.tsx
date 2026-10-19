// 品牌标识（Ω 芯片）：全站唯一的「实心品牌件」，侧栏头与工作状态条共用。
//
// 为什么单独成组件：品牌形状/底色/动效只有一处定义，避免「侧栏是圆角方块、状态条是另一个圆点」
// 这种同一品牌两种长相的漂移；工作状态条要的只是同一枚标识的紧凑版。
//
// 纯展示、aria-hidden：标识是装饰，产品名由旁边的文字承担朗读职责。

import type { ReactElement } from 'react';

/** BrandMark 组件的入参。 */
export interface BrandMarkProps {
  /**
   * 紧凑版（工作状态条用）：更小的尺寸，并换成更快的「工作中」呼吸动画。
   * 缺省为侧栏品牌头的标准版（慢呼吸 + 扫光）。
   */
  compact?: boolean;
}

/**
 * 品牌标识：把 Ω 放进一枚扁平的圆角墨芯片。
 * @param props 组件入参
 * @returns 标识节点
 */
export function BrandMark(props: BrandMarkProps): ReactElement {
  const { compact } = props;
  return (
    <span className={compact === true ? 'brand-mark brand-mark--compact' : 'brand-mark'} aria-hidden="true">
      Ω
    </span>
  );
}
