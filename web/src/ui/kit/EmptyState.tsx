// EmptyState：空态（kit 骨架，W1）。
// 插画按规划自绘（CSS/SVG，不引图库）；W1 先用 antd Empty 的 SIMPLE 形态立住结构，
// W4 控制台迁移时统一换成自绘线稿（Ω 空态/加载/错误三件）。

import * as React from 'react';
// 子路径导入（不走 barrel，理由见 vite.config.ts「分块改造」注释）。
import Empty from 'antd/es/empty';
import Typography from 'antd/es/typography';

/** EmptyState 入参。 */
export interface EmptyStateProps {
  /** 一句话说明（必给：空态必须告诉用户「这里为什么是空的」）。 */
  title: string;
  /** 补充提示（怎么才能不空）。 */
  hint?: string;
  /** 空态动作（如「新建会话」）。 */
  action?: React.ReactNode;
  testId?: string;
}

/**
 * 空态：标题 + 提示 + 可选动作。
 * @param props EmptyStateProps
 * @returns Empty 节点
 */
export function EmptyState(props: EmptyStateProps): React.ReactElement {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Typography.Text type="secondary">
          {props.title}
          {props.hint !== undefined && props.hint !== '' && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {props.hint}
            </Typography.Paragraph>
          )}
        </Typography.Text>
      }
      data-testid={props.testId}
    >
      {props.action}
    </Empty>
  );
}
