// PageHeader：页面/面板统一的「标题 + 说明 + 动作区」头部（kit 骨架，W1）。
// 只做 antd 排版原语的组合；业务组件经 kit 消费 antd，不直接散写 Typography。

import * as React from 'react';
import { Flex, Space, Typography } from 'antd';

/** PageHeader 入参。 */
export interface PageHeaderProps {
  title: string;
  description?: string;
  /** 右侧动作区（按钮/开关等），横向排列。 */
  actions?: React.ReactNode;
  /** 判据锚点（kit 组件统一透传 data-testid）。 */
  testId?: string;
}

/**
 * 页面头部：标题（含截断）、次行说明、右侧动作区。
 * @param props PageHeaderProps
 * @returns 头部节点
 */
export function PageHeader(props: PageHeaderProps): React.ReactElement {
  return (
    <Flex
      justify="space-between"
      align="flex-start"
      gap={12}
      data-testid={props.testId}
      className="kit-page-header"
    >
      <Flex vertical gap={2} style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0 }} ellipsis>
          {props.title}
        </Typography.Title>
        {props.description !== undefined && props.description !== '' && (
          <Typography.Text type="secondary">{props.description}</Typography.Text>
        )}
      </Flex>
      {props.actions !== undefined && <Space wrap>{props.actions}</Space>}
    </Flex>
  );
}
