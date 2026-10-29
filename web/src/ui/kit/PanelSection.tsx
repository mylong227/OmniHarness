// PanelSection：面板内统一的「标题 + 说明 + 内容」卡（kit 骨架，W1）。
// Card 的 headerBg/投影已由 antdTheme 的组件 token 钉成纸与墨口径，这里不再写样式。

import * as React from 'react';
import { Card, Typography } from 'antd';

/** PanelSection 入参。 */
export interface PanelSectionProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  /** 卡片头部右侧的动作区。 */
  extra?: React.ReactNode;
  testId?: string;
}

/**
 * 面板分区卡：控制台/设置页的内容组织单元。
 * @param props PanelSectionProps
 * @returns 卡片节点
 */
export function PanelSection(props: PanelSectionProps): React.ReactElement {
  return (
    <Card
      size="small"
      title={props.title}
      extra={props.extra}
      data-testid={props.testId}
      className="kit-panel-section"
    >
      {props.description !== undefined && props.description !== '' && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {props.description}
        </Typography.Paragraph>
      )}
      {props.children}
    </Card>
  );
}
