// 左栏「文件」区块（从 SessionPanel 抽出）：区块头 + 文件树区。
//
// 区块头是折叠开关：图标条态点它的语义是「展开侧栏并进入该区块」（而不是单纯翻转——图标条下
// 文件区本来就不可见），该判定留在宿主的 toggleTree 里，这里只画按钮。

import type { FsNode } from '../../types/models.ts';
import { renderTreeView } from './SessionViews.tsx';
import { t } from '../i18n/i18n.ts';

/** SessionTreeSection 组件的入参。 */
export interface SessionTreeSectionProps {
  /** 左栏是否已收成图标条（收起时不显示「文件」二字）。 */
  readonly rail: boolean;
  /** 文件区是否展开。 */
  readonly open: boolean;
  /** 文件树。 */
  readonly tree: FsNode[];
  /** 文件树是否已加载完成。 */
  readonly loaded: boolean;
  /** 文件树错误信息（非空即不可用）。 */
  readonly error: string | null;
  /** 折叠 / 展开文件区。 */
  readonly onToggle: () => void;
  /** 打开文件（右栏预览）。 */
  readonly onOpenFile: (path: string) => void;
}

/**
 * 左栏「文件」区块。
 * @param props 组件入参
 * @returns 区块节点（区块头与树区的兄弟片段，不额外包一层 DOM）
 */
export function SessionTreeSection(props: SessionTreeSectionProps): ReactElement {
  const { rail, open, tree, loaded, error, onOpenFile } = props;
  return (
    <>
      <div className="col-head">
        <button className="sec-toggle" aria-expanded={open ? 'true' : 'false'} onClick={props.onToggle}>
          <span className="ws-caret">{open ? '▾' : '▸'}</span>
          {rail ? null : <span>{t('文件')}</span>}
        </button>
      </div>
      {open ? <div className="section tree">{renderTreeView(tree, loaded, error, onOpenFile)}</div> : null}
    </>
  );
}
