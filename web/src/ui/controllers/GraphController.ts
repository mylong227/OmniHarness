// graph 编排运行态控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中 onRunStart / pollRun / graph.progress / graph.done 相关回调，
// 经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { GraphDone, GraphProgress } from '../../types/models.js';
import { MethodBinder } from './methodBinder.js';

/** graph 运行态控制器：单一职责，仅供 App 组合使用。 */
export class GraphController {
  /** 状态宿主（App class 组件）。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;

  /**
   * 构造并绑定对外回调。
   * @param host 状态宿主
   * @param services 共享服务
   */
  public constructor(host: AppHost, services: AppServices) {
    this.host = host;
    this.services = services;
    // 一次绑定全部原型方法。见 MethodBinder。
    MethodBinder.bindAll(this);
  }

  /**
   * 一次编排运行开始：写入初始运行态；若 SSE 不可用则回退轮询。
   * @param runId 运行 id
   * @param name 编排定义名
   * @returns 无
   */
  public onRunStart(runId: string, name: string): void {
    this.host.patch((s) => ({
      graphRuns: { ...s.graphRuns, [runId]: this.services.reducers.buildGraphRunInitial(runId, name) },
    }));
    if (!this.services.stream.isOpen) this.pollRun(runId);
  }

  /**
   * 应用一次 graph 进度事件。
   * @param p graph 进度载荷
   * @returns 无
   */
  public applyGraphProgress(p: GraphProgress): void {
    this.host.patch((s) => ({ graphRuns: this.services.reducers.applyGraphProgress(s.graphRuns, p) }));
  }

  /**
   * 应用一次 graph 完成事件。
   *
   * 除了写状态，失败时**主动提示「可以续跑」**（2026-10-08 交互改进）：续跑入口此前只长在「编排」面板的
   * 运行卡片上，用户得先知道有这个面板、再等它失败、再去卡片里找——学习成本高得没必要。
   * 现在失败的那一刻就告诉他一句人话（并指出去哪儿点，或直接点状态栏的「续跑」）。
   * @param p graph 完成载荷
   * @returns 无
   */
  public applyGraphDone(p: GraphDone): void {
    this.host.patch((s) => ({ graphRuns: this.services.reducers.applyGraphDone(s.graphRuns, p) }));
    if (p.ok === false) {
      const name = this.host.getState().graphRuns[p.runId]?.defName;
      this.services.toast(
        `编排${name ? `「${name}」` : ''}未全部完成：已完成步骤可复用，点「续跑」只重跑剩下的`,
        'err',
      );
    }
  }

  /**
   * 续跑一次未成功的编排运行（**唯一的续跑实现**：面板卡片与状态栏都调它，避免两处各写一套）。
   *
   * 交互口径（为什么是「乐观复位 + 失败复原」而不是「加了锁再等」）：
   * - 乐观复位让按钮**立刻消失**，从根上消掉连点窗口——服务端对同一 runId 的在飞续跑是 fail-closed 的，
   *   连点只会换来一条报错，体感更差；
   * - RPC 失败则**把运行态复原**成失败态并如实报错，绝不让卡片停在「运行中…」假装在跑。
   * @param runId 运行 id
   * @param name 编排定义名（复位后的卡片标题）
   * @returns 无（失败已内部转成提示）
   */
  public async resumeRun(runId: string, name: string): Promise<void> {
    const prev = this.host.getState().graphRuns[runId];
    this.host.patch((s) => ({
      graphRuns: { ...s.graphRuns, [runId]: this.services.reducers.buildGraphRunInitial(runId, name) },
    }));
    if (!this.services.stream.isOpen) this.pollRun(runId);
    try {
      const res = await this.services.api.resumeGraph(runId);
      this.services.toast(`已续跑${name ? `「${name}」` : ''}（复用已完成步骤，只重跑剩下的）`, 'ok');
      void res;
    } catch (e) {
      this.host.patch((s) =>
        prev === undefined ? s : { graphRuns: { ...s.graphRuns, [runId]: prev } },
      );
      this.services.toast('续跑失败：' + (e as Error).message, 'err');
    }
  }

  /**
   * SSE 不可用时的轮询回退：每 500ms 拉一次状态，done 即停（上限 240 次）。
   * @param runId 运行 id
   * @returns 无
   */
  private pollRun(runId: string): void {
    const tick = async (i: number): Promise<void> => {
      if (i >= 240) return;
      try {
        const st = await this.services.api.graphStatus(runId);
        this.host.patch((s) => ({ graphRuns: this.services.reducers.applyGraphStatus(s.graphRuns, runId, st) }));
        if (st.done) return;
      } catch {
        /* 运行态尚未注册，继续 */
      }
      await new Promise((r) => setTimeout(r, 500));
      await tick(i + 1);
    };
    void tick(0);
  }
}
