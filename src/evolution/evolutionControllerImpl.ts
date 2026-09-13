/**
 * 进化控制器（Evolvix 闭环编排，P1 首发块核心）。
 *
 * 把「发现(DiscoveryEngine) → 评估(EvolutionGate) → 晋升(onPromote)」串成一轮闭环。
 * 设计为可注入 OmniHarnessRuntime（可选、默认 undefined、零破坏）：Agent 在任务完成后
 * 若 `autoRun` 开启则跑一轮 `cycle()`，使燧-1/燧-2 等发明层原语真正进入真实循环做 A/B
 * （验证"市面唯一"的实打实增益），且每一次晋升都受 fail-closed 门禁与审计链约束。
 *
 * 铁律：异常不影响主任务（try/catch fail-closed）；无预算则静默退出；晋升回调由调用方注入。
 *
 * @maturity L1 — 进化闭环在；适应度地形（NK）假设未验证
 * @maturityEvidence tests/unit/evolutionIntegration.test.ts
 */
import type {
  Candidate,
  DiscoveryEngine,
  EvolutionController,
  EvolutionControllerOptions,
  EvolutionGate,
  PromotionVerdict,
} from '../ports/runtime/evolution.js';
import type { RlvrLoop } from './rlvrLoop.js';

/** RLVR 阶段配置（U4 升格）：每个过门禁的候选再跑一轮 sample-filter-replay。 */
export interface RlvrStage {
  /** RLVR 主循环（采样→可验证奖励打分→绿样本进回放缓冲）。 */
  readonly loop: RlvrLoop;
  /**
   * 从进化候选抽取 RLVR prompt（如「为这个技能生成一段实现代码」）。
   * 返回 undefined = 跳过该候选的 RLVR 阶段（直接按门禁结果晋升）。
   */
  readonly promptFor: (candidate: Candidate) => string | undefined;
}

/** 进化控制器实现。 */
export class EvolutionControllerImpl implements EvolutionController {
  /** 任务完成后是否自动跑一轮进化（默认 false，确保零破坏旁路）。 */
  public readonly autoRun: boolean;
  private readonly discovery: DiscoveryEngine;
  private readonly gate: EvolutionGate;
  private readonly onPromote?: ((candidate: Candidate) => void) | undefined;
  private readonly rlvr?: RlvrStage | undefined;

  public constructor(opts: EvolutionControllerOptions) {
    this.discovery = opts.discovery;
    this.gate = opts.gate;
    this.onPromote = opts.onPromote;
    this.autoRun = opts.autoRun ?? false;
    this.rlvr = opts.rlvr;
  }

  /** 评估单个候选（直接转发门禁）。 */
  public evaluate(candidate: Candidate): Promise<PromotionVerdict> {
    return this.gate.evaluate(candidate);
  }

  /** 跑一轮：取本批候选 → 逐一评估 → (可选)RLVR 阶段 → 晋升者触发 onPromote。 */
  public async cycle(): Promise<readonly PromotionVerdict[]> {
    const candidates = this.discovery.nextCandidates();
    const verdicts: PromotionVerdict[] = [];
    for (const c of candidates) {
      const v = await this.gate.evaluate(c);
      if (!v.promoted) {
        verdicts.push(v);
        continue;
      }
      // (U4) RLVR 阶段：过门禁后还需「绿样本」才晋升，否则 sample-filter-replay 否决。
      if (this.rlvr !== undefined) {
        const prompt = this.rlvr.promptFor(c);
        if (prompt !== undefined) {
          let blocked = false;
          let reasonSuffix = '';
          try {
            const r = await this.rlvr.loop.run(prompt);
            if (r.best === undefined) {
              blocked = true;
              reasonSuffix = '；RLVR 阶段无绿样本（sample-filter-replay 否决晋升）';
            }
          } catch {
            blocked = true;
            reasonSuffix = '；RLVR 阶段异常（fail-closed 否决晋升）';
          }
          if (blocked) {
            verdicts.push({ ...v, promoted: false, reason: `${v.reason}${reasonSuffix}` });
            continue;
          }
        }
      }
      this.onPromote?.(c);
      verdicts.push(v);
    }
    return verdicts;
  }

  /** 当前预算消耗。 */
  public budgetUsed(): { readonly generated: number; readonly maxCandidates: number } {
    return this.discovery.budgetUsed();
  }
}

/** 便捷构造（同 EvolutionControllerImpl，名称更贴近端口）。 */
export function createEvolutionController(opts: EvolutionControllerOptions): EvolutionController {
  return new EvolutionControllerImpl(opts);
}
