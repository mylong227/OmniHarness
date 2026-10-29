// StatusTag：状态徽标（kit 骨架，W1）——语义色映射唯一收口。
// 纸与墨的语义族（ok/warn/err/info）在 antd 里对应 preset 色（seed 已由主题钉死为 palette 值）；
// 业务组件不得再自写 Tag color 字符串散点。

import * as React from 'react';
// 子路径导入（不走 barrel，理由见 vite.config.ts「分块改造」注释）。
import Tag from 'antd/es/tag';

/** 支持的状态语义（与 theme.css 的语义族一一对应；neutral = 无色灰标）。 */
export type StatusKind = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

/** StatusKind → antd Tag color preset（neutral 不带 color，走默认灰）。 */
const TAG_COLOR: Record<StatusKind, string | undefined> = {
  ok: 'success',
  warn: 'warning',
  err: 'error',
  info: 'processing',
  neutral: undefined,
};

/** StatusTag 入参。 */
export interface StatusTagProps {
  status: StatusKind;
  children: React.ReactNode;
  testId?: string;
}

/**
 * 状态徽标：ok=正常 / warn=关注 / err=失败 / info=进行中 / neutral=中性。
 * @param props StatusTagProps
 * @returns Tag 节点
 */
export function StatusTag(props: StatusTagProps): React.ReactElement {
  return (
    <Tag color={TAG_COLOR[props.status]} data-testid={props.testId}>
      {props.children}
    </Tag>
  );
}
