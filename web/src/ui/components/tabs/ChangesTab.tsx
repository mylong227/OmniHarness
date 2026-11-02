// 变更面板（git 式）：拉取 changes.list 展示当前工作区文件变更清单（状态 + 增删行数），
// 点击文件查看 patch。git 仓库用真实 git status/diff；非 git 工作区回退聚合本进程 turn_diff 事件。
// 内联审查：hunk 级 stage/revert（真实 git apply 操作）+ 行内评论（锚定行持久化）。
// 键盘评审（A1）：j/k（或 ↑/↓）在改动块间移动选中、a 接受（stage）、r 拒绝（revert）、c 评论、? 帮助；
// 焦点在输入框内时一律不响应（判据在 models/ReviewKeyboard，见其文件头注释）。
//
// 2026-11-02 S2 清偿：状态与动作下沉到 useChangesReview（五个内聚 hook），本文件只留渲染。
// 行 / 评论 / 草稿 / patch 视图继续复用 ChangesPatchView 的模块级渲染函数。

import type { ReactElement } from 'react';
import { statusBadge } from '../../textUtils.ts';
import { icon } from '../../models/Icon.ts';
import { emptyNote, emptyState } from '../../format.ts';
import {
  renderChangesPatch,
  type ChangeFile,
} from './ChangesPatchView.tsx';
import { useChangesReview } from './useChangesReview.ts';
import type { ChangesReview } from './useChangesReview.ts';
import { t } from '../../i18n/i18n.ts';
// 面板级 antd 一律子路径导入（不走 'antd' 桶文件，理由见 vite.config.ts「分块改造」注释）。
import Table from 'antd/es/table';
import type { ColumnsType } from 'antd/es/table';

const DIM_TEXT: Record<string, string> = { fontSize: '12px', color: 'var(--dim)' };
const RETRY_BOX: Record<string, string> = { marginTop: '10px' };

/** 快捷键帮助条目（文案与 ReviewKeyboard 的绑定表同源，改键时一起改）。 */
const KEY_HELP: readonly { readonly keys: string; readonly desc: string }[] = [
  { keys: 'j / ↓', desc: '选中下一个改动块' },
  { keys: 'k / ↑', desc: '选中上一个改动块' },
  { keys: 'a', desc: '接受（stage）选中块' },
  { keys: 'r', desc: '拒绝（丢弃）选中块，需确认' },
  { keys: 'c', desc: '在选中块的首个改动行写评论' },
  { keys: 'Enter', desc: '未展开时打开选中文件' },
  { keys: '?', desc: '开合本帮助 · Esc 关闭' },
];

/**
 * 变更文件表（2026-10-29 W4）：清单外壳用 antd Table；patch 视图仍是**自研 diff**（§5.4 映射），
 * 经 `renderExpanded` 塞进行展开区。行点击 = 展开/收起（expandRowByClick），键盘评审不动
 * （j/k/Enter 仍走 review-root 的 keydown，选中高亮经 rowClassName 落在行上）。
 */
function ChangesFilesTable(props: {
  files: readonly ChangeFile[];
  expanded: string | null;
  selected: number;
  onOpen: (path: string) => void;
  renderExpanded: (f: ChangeFile) => ReactElement;
}): ReactElement {
  const columns: ColumnsType<ChangeFile> = [
    {
      title: t('状态'),
      key: 'status',
      width: 72,
      render: (_, f) => {
        const badge = statusBadge(f.status);
        return <span className={'change-badge ' + badge.cls}>{badge.label}</span>;
      },
    },
    {
      title: t('路径'),
      dataIndex: 'path',
      key: 'path',
      render: (p: string) => <span className="change-path">{p}</span>,
    },
    {
      title: t('增删'),
      key: 'nums',
      width: 130,
      render: (_, f) => (
        <span className="change-nums">
          {f.additions > 0 ? <span className="additions">+{f.additions}</span> : null}
          {f.deletions > 0 ? <span className="deletions">−{f.deletions}</span> : null}
        </span>
      ),
    },
  ];
  return (
    <Table<ChangeFile>
      className="changes-table"
      size="small"
      bordered={false}
      pagination={false}
      columns={columns}
      dataSource={[...props.files]}
      rowKey="path"
      rowClassName={(f) => {
        const idx = props.files.indexOf(f);
        return (
          'change-row' + (props.expanded === null && idx === props.selected ? ' selected' : '')
        );
      }}
      expandable={{
        expandedRowKeys: props.expanded === null ? [] : [props.expanded],
        onExpand: (_expanded, f) => props.onOpen(f.path),
        expandRowByClick: true,
        expandedRowRender: (f) => props.renderExpanded(f),
      }}
      scroll={{ x: 'max-content' }}
    />
  );
}

/** 变更读取失败态（重试入口）。 */
function ChangesError(props: { error: string; onRetry: () => void }): ReactElement {
  return (
    <div>
      {emptyState(
        icon('alert', { size: 20 }),
        t('变更读取失败：{msg}', { msg: props.error }),
        undefined,
        'err',
      )}
      <div style={RETRY_BOX}>
        <button className="btn" onClick={props.onRetry}>
          {t('重试')}
        </button>
      </div>
    </div>
  );
}

/** 面板头：Git 来源说明 / 刷新 / 快捷键帮助开合。 */
function ChangesPaneHead(props: {
  isGit: boolean;
  branch: string | undefined;
  help: boolean;
  onToggleHelp: () => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <>
      <div className="pane-head">
        <span style={DIM_TEXT}>
          {props.isGit
            ? t('Git 工作区{branch} · 支持块级 stage/丢弃 与 行内评论', {
                branch: props.branch ? ' · ' + props.branch : '',
              })
            : t('本会话产生的变更（非 git 工作区）')}
        </span>
        <button className="btn" onClick={props.onRefresh}>
          {t('↻ 刷新')}
        </button>
      </div>
      <div className="review-hint">
        {t('键盘：j/k 选择 · a 接受 · r 拒绝 · c 评论 ·')}{' '}
        <button
          className="rh-toggle"
          aria-expanded={props.help ? 'true' : 'false'}
          onClick={props.onToggleHelp}
        >
          {t('? 帮助')}
        </button>
      </div>
    </>
  );
}

/** 快捷键帮助浮层。 */
function ReviewHelp(props: { onClose: () => void }): ReactElement {
  return (
    <div
      className="review-help"
      data-review-help="1"
      role="dialog"
      aria-modal="false"
      aria-label={t('变更审查快捷键')}
    >
      <div className="rh-head">{t('键盘评审快捷键（输入框内不生效）')}</div>
      <ul className="rh-list">
        {KEY_HELP.map((k) => (
          <li key={k.keys}>
            <kbd>{k.keys}</kbd>
            <span>{t(k.desc)}</span>
          </li>
        ))}
      </ul>
      <button className="btn" onClick={props.onClose}>
        {t('关闭（Esc）')}
      </button>
    </div>
  );
}

/** 变更面板主体：头 + 帮助 + 文件表（展开区渲染 patch）。 */
function ChangesReviewPane(props: { model: ChangesReview }): ReactElement {
  const m = props.model;
  return (
    <div
      className="review-root"
      data-review-root="1"
      tabIndex={0}
      role="region"
      aria-label={t('变更审查（键盘：j/k 选择 · a 接受 · r 拒绝 · c 评论 · ? 帮助）')}
      ref={m.rootRef}
      onKeyDown={m.onReviewKey}
    >
      <ChangesPaneHead
        isGit={m.isGit}
        branch={m.data?.branch}
        help={m.help}
        onToggleHelp={m.toggleHelp}
        onRefresh={() => void m.refresh()}
      />
      {m.help ? <ReviewHelp onClose={m.closeHelp} /> : null}
      {m.files.length === 0 ? (
        <div className="empty">
          {icon('check', { size: 14 })} {t('没有变更——工作区很干净。改点东西再来看。')}
        </div>
      ) : (
        <ChangesFilesTable
          files={m.files}
          expanded={m.expanded}
          selected={m.selectedView}
          onOpen={(p) => void m.openPatch(p)}
          renderExpanded={(f) =>
            renderChangesPatch({
              f,
              isGit: m.isGit,
              patch: m.patch,
              patchLoading: m.patchLoading,
              fileComments: m.comments.filter((c) => c.path === f.path),
              busyAct: m.busyAct,
              draft: m.draft,
              draftText: m.draftText,
              selected: m.selectedView,
              onSelectHunk: (idx) => m.setSelected(idx),
              onStageFile: m.stageFile,
              onRevertFile: (p) => void m.revertFile(p),
              onStageHunk: m.stageHunk,
              onRevertHunk: (p, h, i) => void m.revertHunk(p, h, i),
              onStartDraft: (a) => {
                m.setDraft(a);
                m.setDraftText('');
              },
              onDraftText: m.setDraftText,
              onSaveDraft: () => void m.saveDraft(),
              onCancelDraft: () => m.setDraft(null),
              onDeleteComment: (id) => void m.deleteComment(id),
            })
          }
        />
      )}
    </div>
  );
}

/**
 * 变更审查面板：工作区变更清单 + 块级 stage / 丢弃 + 行内评论 + 键盘评审。
 * @returns 变更面板节点
 */
export function ChangesTab(): ReactElement {
  const model = useChangesReview();
  if (!model.loaded && model.data === null) return emptyNote(t('读取中…'), { icon: 'rewind' });
  if (model.error !== null) return <ChangesError error={model.error} onRetry={() => void model.refresh()} />;
  return <ChangesReviewPane model={model} />;
}
