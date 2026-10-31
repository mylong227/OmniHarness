// 中栏空态（等待任务 + 「快速开始」示例）。
//
// 从 `StreamView` 抽出（2026-10-31）：组件函数体有行数基线（check.mjs 铁律 80 行 / 存量基线），
// 空态是一段自足、无状态的展示块，独立成文件后既守住基线，也让「示例填进输入框」这条引导
// 只有一个挂点。

import type { ReactElement } from 'react';
import { icon } from '../../models/Icon.ts';
import { t } from '../../i18n/i18n.ts';
import { StarterTasks } from '../../models/StarterTasks.ts';

/** 空态入参。 */
export interface StreamEmptyProps {
  /** 把示例填进输入框（undefined 时不渲染示例区：组件在没有回调时仍可用）。 */
  readonly onUseStarter?: ((text: string) => void) | undefined;
}

/**
 * 中栏空态：一句"这里会发生什么" + 四条可直接改的示例任务。
 * @param props 组件入参
 * @returns 空态节点
 */
export function StreamEmpty(props: StreamEmptyProps): ReactElement {
  const { onUseStarter } = props;
  return (
    <div className="empty illu starter-empty">
      <div className="illu-icon">{icon('message', { size: 20 })}</div>
      <div className="illu-text">{t('等待任务')}</div>
      <div className="illu-hint">{t('下达任务后，模型推理、工具调用与结果将在此实时呈现。')}</div>
      {onUseStarter === undefined ? null : (
        // 「快速开始」：只说"这里会发生什么"是不够的——新客户卡在"第一句话怎么写"。
        // 四条示例各覆盖一条核心通路（读文件 / 跑命令 / 搜索 / 写代码），点一下填进输入框。
        <div className="starter-tasks">
          <div className="starter-title">{t('试试这些（点一下填进输入框，可改后再发）')}</div>
          <div className="starter-list">
            {StarterTasks.list().map((task) => (
              <button
                key={task.label}
                type="button"
                className="starter-task"
                // 悬停给完整任务描述：按钮上的标签是"能力名"，客户要看到真会发出去的那句话。
                title={t(task.prompt)}
                onClick={() => onUseStarter(t(task.prompt))}
              >
                <span className="starter-ico" aria-hidden="true">
                  {icon(task.icon, { size: 14 })}
                </span>
                <span className="starter-label">{t(task.label)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
