// 工作状态条：回合进行中显示「已工作 X分X秒 ›」可折叠行，让「看不见的等待」变成「看得见的干活」。
// 收起只留计时（对齐标杆「已工作 44 分 51 秒 ›」的安静形态）；展开补一行当前动作
// （正在执行命令 / 思考中）。当前动作同时也在流区的 live-input 行里实时滚动，这里不丢信息。
// 函数组件范式：计时起点用 useRef，周期刷新用 useState + 空依赖 effect（清理函数对称清掉 interval），
// 展开/收起一个 useState。

import * as React from 'react';
import { BrandMark } from './BrandMark.tsx';
import { formatDuration } from '../models/DurationFormat.ts';
import { describeToolCall } from '../textUtils.ts';
import { t } from '../i18n/i18n.ts';

/** WorkIndicator 组件的入参。 */
export interface WorkIndicatorProps {
  /** 当前正在调用的工具名；为 null 表示尚未进入工具阶段（展示「思考中」）。 */
  activeTool: string | null;
}

/** 计时刷新间隔（ms）。 */
const TICK_MS = 1000;

/**
 * 工作状态条：渲染可折叠的计时行（收起 = 已工作 + 计时 + ▸；展开 = 追加当前动作）。
 * @param props 组件入参
 * @returns 状态条节点
 */
export function WorkIndicator(props: WorkIndicatorProps): ReactElement {
  const { activeTool } = props;
  const [elapsed, setElapsed] = React.useState<number>(0);
  const [open, setOpen] = React.useState<boolean>(false);
  const startedAtRef = React.useRef<number>(0);

  // 挂载即起表、卸载即停表（[] 有意：计时与 props 无关，只跑一次）。
  React.useEffect(() => {
    startedAtRef.current = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, []);

  // 工具名翻译成人话（shell → 执行命令 / sketch_write → 生成草图），避免把原始工具名
  // 直接甩给用户；过程簇那一行还会带具体参数，这里只保留动作类别。
  const action =
    activeTool != null
      ? t('正在{action}', { action: describeToolCall(activeTool, {}) })
      : t('思考中');
  // role=status：忙碌态是异步状态变化，让辅助技术播报「在干什么」；当前动作文案放在
  // 展开层里保证可读（收起态只藏计时数字——对朗读无信息量）。
  return (
    <div className="work-indicator" role="status" aria-live="polite">
      <button
        className="wi-toggle"
        aria-expanded={open ? 'true' : 'false'}
        title={open ? t('收起当前动作') : t('查看当前动作')}
        onClick={() => setOpen((v) => !v)}
      >
        <BrandMark compact />
        <span className="wi-label">{t('已工作')}</span>
        <span className="wi-time" aria-hidden="true">
          {formatDuration(elapsed)}
        </span>
        <span className="wi-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="wi-action">{action}</div> : null}
    </div>
  );
}
