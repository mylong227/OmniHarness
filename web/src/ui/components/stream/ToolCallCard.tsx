// 工具调用行：步骤列表的一行「动作标签 | 对象 | 度量」，点击展开 args 与结果详情。
//
// 2026-10-20 用户口径：不显示使用了什么工具，像活动记录一样展示——
//   · 左列固定宽度的动作标签（读取 / 写入 / 编辑 / 运行命令 / 生成草图…）；
//   · 右列对象（路径 / 命令 / 查询）；写类动作末尾给体积与增删行；
//   · 成功不出徽标，只有运行中 / 失败才出状态；失败原因仍然直显（不折叠）；
//   · 行可点开 args 与结果，保留钻取入口。
// 2026-10-19 去噪：去掉行尾时间戳与「成功」徽标、写类产物卡不再无条件内联。

import * as React from 'react';
import { jsonView } from '../../format.ts';
import { truncate, isArtifactCall, toolMeta, toolSubject, toolVerb } from '../../textUtils.ts';
import { ArtifactResolver } from '../../models/ArtifactResolver.ts';
import { icon } from '../../models/Icon.ts';
import type { IconName } from '../../models/Icon.ts';
import { ArtifactCard } from './ArtifactCard.tsx';
import type { ThreadEvent } from '../../../types/models.ts';
import type { ToolResultView } from '../StreamView.tsx';
import { t } from '../../i18n/i18n.ts';

/** ToolCallCard 组件的入参。 */
export interface ToolCallCardProps {
  /** 工具调用事件（payload.name / payload.args）。 */
  ev: ThreadEvent;
  /** 该调用的结果视图（未返回时为 undefined）。 */
  res?: ToolResultView;
  /** 点击「在钻取面板查看」时上抛事件。 */
  onEventClick: (ev: ThreadEvent) => void;
  /** 打开产物文件（在右侧面板预览）。 */
  onOpenFile?: (path: string) => void;
  /**
   * 是否渲染内联产物卡（缺省 true）。
   *
   * 结果卡出现后，写类调用的产物由回合结果卡统一展示（避免同一文件在过程与结果里各出现一次）；
   * 运行中 / 没有 turn_diff 的兜底路径才保留内联卡，保证「刚写出来的东西」立刻可见。
   */
  showArtifact?: boolean;
}

/** 工具名 → 图标（未登记的工具回落到扳手）。 */
const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  read_file: 'file',
  list_dir: 'folder',
  shell: 'command',
  bash: 'command',
  search: 'search',
  grep: 'search',
  write_file: 'file',
  apply_patch: 'pencil',
  sketch_write: 'image',
  plan_read: 'book',
  plan_write: 'book',
  plan_present: 'book',
  todo_write: 'check',
  delegate: 'robot',
  subagent: 'robot',
  mcp: 'plug',
};

/**
 * 工具调用卡片：摘要行 + 可展开的 args / 结果详情，失败时行尾直显错误。
 * @param props 组件入参
 * @returns 工具调用节点
 */
export function ToolCallCard(props: ToolCallCardProps): ReactElement {
  const { ev, res, onEventClick, onOpenFile, showArtifact } = props;
  const [open, setOpen] = React.useState<boolean>(false);
  const p = ev.payload || {};
  const status = res ? (res.ok ? 'ok' : 'err') : 'pending';
  const statusText = res ? (res.ok ? t('成功') : t('失败')) : t('运行中…');
  const toolName = (p.name as string) || 'tool';
  const verb = t(toolVerb(toolName));
  const subject = toolSubject(toolName, p.args);
  const meta = toolMeta(toolName, p.args);
  const errText = res && !res.ok && res.text ? res.text.replace(/^✗\s*/, '') : '';
  // 产物卡片：只对**写类工具**（write_file / apply_patch / sketch_write）解析。
  // read_file / lsp_* 只是引用，给它们挂产物卡会让过程流又变成一串文件卡（2026-10-19 去噪）。
  const artifact =
    res && res.ok && isArtifactCall(ev)
      ? ArtifactResolver.fromTool(toolName, p.args, res.text)
      : null;

  /** 展开 / 收起详情。 */
  const toggle = (): void => setOpen((prev) => !prev);

  /**
   * 键盘开合（行是 role=button，Enter / Space 与点击同义）。
   * @param e 键盘事件
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  /**
   * 钻取：阻断冒泡，避免同时触发外层的事件点击。
   * @param e 点击事件
   */
  const drill = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onEventClick(ev);
  };

  return (
    <div className="ev tool_call">
      <div
        className="tc-line"
        onClick={toggle}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? t('收起详情') : t('点击查看调用详情')}
      >
        <span className="tc-icon" aria-hidden="true">
          {icon(TOOL_ICONS[toolName] ?? 'wrench', { size: 14 })}
        </span>
        <span className="tc-verb">{verb}</span>
        {subject === '' ? null : (
          <>
            <span className="tc-dot" aria-hidden="true">
              ·
            </span>
            <span className="tc-subject" title={subject}>
              {subject}
            </span>
          </>
        )}
        {meta === '' ? null : <span className="tc-meta">{meta}</span>}
        {status === 'err' ? <span className="tool-status err">{statusText}</span> : null}
        {status === 'pending' ? <span className="tool-status pending">{statusText}</span> : null}
      </div>
      {errText ? (
        <div className="tc-error" title={errText}>
          {icon('alert', { size: 13 })} {truncate(errText, 160)}
        </div>
      ) : null}
      {artifact !== null && showArtifact !== false ? (
        <ArtifactCard info={artifact} onOpen={onOpenFile} />
      ) : null}
      {open ? (
        <div className="tc-detail">
          {p.args ? jsonView(p.args) : null}
          <div className="tool-result">
            {res ? (
              <div className="tool-output">{res.text}</div>
            ) : (
              <div className="tool-output tc-waiting">{t('等待结果…')}</div>
            )}
          </div>
          <button className="tc-drill" title={t('在右侧钻取面板查看原始事件')} onClick={drill}>
            {t('⤢ 在钻取面板查看')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
