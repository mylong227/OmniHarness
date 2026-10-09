// 「编排没跑完」的状态栏入口：把续跑从「需要学会找面板」降到「低头就能看见」。
//
// 交互依据（2026-10-08 用户反馈：入口藏在三层之下、学习成本太高）：续跑此前只长在「编排」面板的
// 运行卡片上，用户得先知道有这个面板、再等它失败、再去卡片里翻。状态栏是用户在对话时**一直看得见**
// 的一条带，把「有运行时没跑完 + 一键续跑」放在这里，就不需要先学会导航。
// 纯展示组件（函数组件范式）：状态由父注入，点击回调上抛，无副作用。

import { React } from '../deps.js';
import type { GraphRunState } from '../../types/models.js';

/** 状态栏续跑入口的入参。 */
export interface GraphResumeChipProps {
  /** 各次运行的实时状态（与「编排」面板同源，避免两处口径漂移）。 */
  runs: Record<string, GraphRunState>;
  /** 续跑回调（实现只有一处：`GraphController.resumeRun`）。 */
  onResume: (runId: string, name: string) => void;
}

/**
 * 找最近一次「已结束但未成功」的运行（取最新一条）。
 *
 * 判据依据：本系统只生成两种 runId，**都是时间前缀** ⇒ 字典序即时序：
 * - `WorkflowRunLog.newRunId`：`wf-[slug-]<yyyyMMdd'T'HHmmss>-<6位>`（定长，可直接比）；
 * - serve 台账 `Id.id('run')`：`run_<Date.now().toString(36)>_<计数>`（毫秒的 base36 在本世纪恒为 9 位，
 *   故也是定长可比；仅当同一毫秒内计数跨位数时顺序可能反，属可接受退化）。
 * 两者混用时以字典序排列可能不精确（`run_` 与 `wf-` 不同源）——此时退化为「按 id 序取最后一条」，
 * 用户在芯片上能看到具体编排名，点错了也不会造成破坏（续跑幂等于「已完成步骤不重跑」）。
 * @param runs 运行态映射
 * @returns 最近一次未成功的运行；没有则为 undefined
 */
function latestFailed(runs: Record<string, GraphRunState>): GraphRunState | undefined {
  const failed = Object.values(runs).filter((r) => r.done && !r.ok);
  if (failed.length === 0) return undefined;
  return failed.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))[0];
}

/**
 * 状态栏的「编排未完成 · 续跑」芯片：没有未完成的运行时**不渲染任何节点**（不占位、不噪音）。
 * @param props 组件入参
 * @returns 芯片节点或 null
 */
export function GraphResumeChip(props: GraphResumeChipProps): ReactElement | null {
  const run = latestFailed(props.runs);
  if (run === undefined) return null;
  const done = run.nodes.filter((n) => n.status === 'done').length;
  const rest = Math.max(0, run.nodes.length - done);
  return (
    <button
      className="cs-item cs-resume"
      title={
        rest > 0
          ? `复用已完成 ${done} 步的产出，只重跑剩下 ${rest} 步（同一运行 id，进度会实时刷新）`
          : '复用已完成步骤的产出，只重跑未完成的步骤'
      }
      onClick={() => props.onResume(run.runId, run.defName)}
    >
      ↻ 续跑{run.defName ? `「${run.defName}」` : ''}
    </button>
  );
}
