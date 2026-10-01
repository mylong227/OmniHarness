import type { CrisprEditReport } from './crisprEditReport.js';
import type { CrisprEditSpec } from './crisprEditSpec.js';

/** CRISPR 精确技能编辑器端口。 */
export interface CRISPRSkillEditorPort {
  /** 精确编辑一次：语义寻址定位 → 定点 patch → 差异测试（fail-closed 回滚）。 */
  edit(spec: CrisprEditSpec): CrisprEditReport;
  /** 排入编辑队列（供主循环任务末批量 flush）。 */
  queue(spec: CrisprEditSpec): void;
  /** 批量执行队列（主循环用）；空队列返回空数组。 */
  flush(): readonly CrisprEditReport[];
  /** 已成功应用（提交）的编辑数。 */
  appliedCount(): number;
}
