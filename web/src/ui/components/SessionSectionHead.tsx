// 左栏「任务列表」区块头（从 SessionPanel 抽出）：标题 + 图标簇（搜索 / 范围 / 视图 / 添加项目）。
//
// 图标条态只留搜索（其余入口在展开后才有意义）；搜索按钮的 aria-expanded / aria-label 同时承担
// 开合状态播报，视图按钮的 title 与 aria-label 同为「下一个视图」的提示。

import { icon } from '../models/Icon.ts';
import type { PanelView } from './session/viewCycle.ts';
import { t } from '../i18n/i18n.ts';

/**
 * 下一个视图的提示文案（同时作为 aria-label）。
 * @param view 当前视图
 * @returns 中文字样
 */
function nextViewTitle(view: PanelView): string {
  return view === 'time' ? t('切换到按工作区分组') : view === 'ws' ? t('切换到任务卡视图') : t('切换到时间分组');
}

/** SessionSectionHead 组件的入参。 */
export interface SessionSectionHeadProps {
  /** 左栏是否已收成图标条（收起时只留搜索）。 */
  readonly rail: boolean;
  /** 搜索框是否展开。 */
  readonly searchOpen: boolean;
  /** 会话列表是否显示**全部项目**（缺省只看当前项目）。 */
  readonly scopeAll?: boolean | undefined;
  /** 唤出 / 收起搜索框。 */
  readonly onToggleSearch: () => void;
  /** 翻转显示范围（当前项目 ⇄ 全部项目）；缺省则不渲染该按钮。 */
  readonly onToggleScope?: (() => void) | undefined;
  /** 当前视图（决定「下一个视图」的提示文案）。 */
  readonly view: PanelView;
  /** 切换到下一个视图（三态循环）。 */
  readonly onCycleView: () => void;
  /** 打开「添加项目」目录选择器。 */
  readonly onAddProject: () => void;
}

/**
 * 左栏「任务列表」区块头。
 * @param props 组件入参
 * @returns 区块头节点
 */
export function SessionSectionHead(props: SessionSectionHeadProps): ReactElement {
  const { rail, searchOpen, scopeAll, view, onToggleSearch, onToggleScope, onCycleView, onAddProject } = props;
  return (
    <div className="side-sec-head">
      <span className="ssh-label">{rail ? null : t('任务列表')}</span>
      <span className="flex-spacer" aria-hidden="true"></span>
      <span className="ssh-actions">
        <button
          className={'ws-add' + (searchOpen ? ' active' : '')}
          title={searchOpen ? t('收起搜索') : t('搜索会话与文件')}
          aria-label={searchOpen ? t('收起搜索') : t('搜索会话与文件')}
          aria-expanded={searchOpen ? 'true' : 'false'}
          onClick={onToggleSearch}
        >
          {icon('search', { size: 14 })}
        </button>
        {rail ? null : (
          <>
            {onToggleScope === undefined ? null : (
              <button
                className={'ws-add' + (scopeAll === true ? ' active' : '')}
                title={
                  scopeAll === true
                    ? t('当前显示**全部项目**的会话（点击只看本项目）')
                    : t('当前只显示**本项目**的会话（点击看全部项目）')
                }
                aria-label={scopeAll === true ? t('切换为只看本项目') : t('切换为看全部项目')}
                aria-pressed={scopeAll === true ? 'true' : 'false'}
                onClick={onToggleScope}
              >
                {icon('sliders', { size: 14 })}
              </button>
            )}
            <button className="ws-add" title={nextViewTitle(view)} aria-label={nextViewTitle(view)} onClick={onCycleView}>
              {icon('columns', { size: 14 })}
            </button>
            <button className="ws-add" title={t('添加项目')} aria-label={t('添加项目')} onClick={onAddProject}>
              {icon('plus', { size: 14 })}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
