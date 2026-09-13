// graph 编排运行态控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中 onRunStart / pollRun / graph.progress / graph.done 相关回调，
// 经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { GraphDone, GraphProgress } from '../../types/models.js';

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
    this.onRunStart = this.onRunStart.bind(this);
    this.applyGraphProgress = this.applyGraphProgress.bind(this);
    this.applyGraphDone = this.applyGraphDone.bind(this);
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
   * @param p graph 完成载荷
   * @returns 无
   */
  public applyGraphDone(p: GraphDone): void {
    this.host.patch((s) => ({ graphRuns: this.services.reducers.applyGraphDone(s.graphRuns, p) }));
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
