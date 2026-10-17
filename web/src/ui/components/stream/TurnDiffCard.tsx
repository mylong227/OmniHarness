// 回合变更卡片（对标 Codex 桌面版「Edited N files」）：回合结束时按文件列出本轮修改。
//
// 结构：头部「已编辑 N 个文件 +增 −删」+ 收起/展开开关；文件清单每行「路径 + 该文件增删」，
// 点击行展开该文件的 unified diff 正文（复用 format.diffView 的行级着色）。
//
// 数据来自 turn_diff 事件 payload.diff（整回合 unified diff），解析走纯模型 TurnDiffFiles
// （可脱离 React 单测）。解析不出任何文件段（如 diff 为空）时退回原始 diff 呈现，不白屏。

import { React } from '../../deps.js';
import { parseTurnDiffFiles, turnDiffTotals } from '../../models/TurnDiffFiles.js';
import { diffView } from '../../format.js';
import { t } from '../../i18n/i18n.js';

/** TurnDiffCard 入参。 */
export interface TurnDiffCardProps {
  /** turn_diff 事件 payload.diff（整回合 unified diff 文本）。 */
  readonly diff: string;
}

/**
 * 回合变更卡片组件。
 * @param props diff 文本。
 * @returns 卡片元素。
 */
export function TurnDiffCard(props: TurnDiffCardProps): React.ReactElement {
  const files = React.useMemo(() => parseTurnDiffFiles(props.diff), [props.diff]);
  const [listOpen, setListOpen] = React.useState(true);
  const [openFiles, setOpenFiles] = React.useState<ReadonlySet<string>>(new Set());

  if (files.length === 0) {
    // 无可解析文件段：退回原始 diff（保留旧行为，不静默吞内容）。
    return React.createElement('div', { className: 'diff' }, diffView(props.diff));
  }

  const totals = turnDiffTotals(files);
  const toggleFile = (path: string): void => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return React.createElement(
    'div',
    { className: 'turn-diff-card' },
    // 头部：标题 + 合计 + 收起/展开开关。
    React.createElement(
      'div',
      { className: 'tdc-head' },
      React.createElement('span', { className: 'tdc-title' }, t('已编辑 {n} 个文件', { n: files.length })),
      React.createElement(
        'span',
        { className: 'tdc-total' },
        React.createElement('span', { className: 'add' }, `+${totals.added}`),
        ' ',
        React.createElement('span', { className: 'del' }, `−${totals.deleted}`),
      ),
      React.createElement(
        'button',
        {
          className: 'tdc-toggle',
          onClick: () => setListOpen((v) => !v),
          'aria-expanded': listOpen,
        },
        listOpen ? t('收起文件') : t('展开文件'),
      ),
    ),
    // 文件清单：每行「路径 + 增删」，点击展开该文件 diff 正文。
    listOpen
      ? React.createElement(
          'div',
          { className: 'tdc-list' },
          files.map((f) =>
            React.createElement(
              'div',
              { className: 'tdc-file', key: f.path },
              React.createElement(
                'button',
                {
                  className: 'tdc-row',
                  onClick: () => toggleFile(f.path),
                  'aria-expanded': openFiles.has(f.path),
                  title: f.path,
                },
                React.createElement('span', { className: 'tdc-path' }, f.path),
                React.createElement(
                  'span',
                  { className: 'tdc-stat' },
                  React.createElement('span', { className: 'add' }, `+${f.added}`),
                  ' ',
                  React.createElement('span', { className: 'del' }, `−${f.deleted}`),
                ),
              ),
              openFiles.has(f.path)
                ? React.createElement('div', { className: 'tdc-body' }, diffView(f.text))
                : null,
            ),
          ),
        )
      : null,
  );
}
