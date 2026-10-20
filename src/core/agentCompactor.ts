import type { OmniHarnessRuntime } from '../ports/composition/omniHarnessRuntime.ts';
import type { TokenEstimatorCalibrator } from '../context/tokenEstimatorCalibrator.ts';
import { ContextCompactor } from '../context/contextCompactor.ts';
import { ContextWindowCatalog } from '../context/contextWindowCatalog.ts';
import { NativeTokenAccounting } from './nativeTokenAccounting.ts';

/** 默认压缩参数。 */
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_KEEP_RECENT = 6;

/**
 * 构造 Agent 的上下文压缩器（2026-10-21 从 `Agent` 拆出）。
 *
 * 拆出原因：`Agent` 已 26 个方法 / 超过上帝类门禁；压缩器装配是**独立关注点**
 * （窗口目录 + 校准器 + 原生估算器），与主循环编排无关。
 */
export class AgentCompactor {
  /**
   * 构建上下文压缩器（阈值挂钩真实 context window，0.8×window 优先于固定值）。
   *
   * **2026-10-14 修（压缩阈值与真实窗口脱钩）**：默认档此前恒为固定 8000 token——128k 窗口的
   * 模型在用量 ~6k 时就触发折叠，且 `keepRecent=6` 会把刚读的文件内容整体折进摘要；摘要塌陷
   * （真机实测「摘要 13 字」）后模型每步失忆，无限重启探索循环。现默认阈值 = 0.8×真实窗口
   * （env `OMNI_CONTEXT_WINDOW` → 模型名目录 → 缺省 128k）；仅当用户**显式**配置
   * `compactionMaxTokens` 时维持固定阈值契约。
   * @param runtime 运行时组合根。
   * @param calibration token 估算校准器（与 StepRunner 共享同一实例）。
   * @returns 配置好压缩阈值与（可选）原生 token 估算器的 ContextCompactor。
   */
  public static build(
    runtime: OmniHarnessRuntime,
    calibration: TokenEstimatorCalibrator,
  ): ContextCompactor {
    const compactor = new ContextCompactor(runtime.model, {
      maxTokens: runtime.config.compactionMaxTokens ?? DEFAULT_MAX_TOKENS,
      keepRecent: runtime.config.compactionKeepRecent ?? DEFAULT_KEEP_RECENT,
      // P2（打磨）：确定性无损收缩显式透传（配置缺省即 true），杜绝「声明未接线」死旋钮。
      deterministicShrink: runtime.config.compactionDeterministicShrink ?? true,
      // CTX-02：共享同一校准器实例，样本 ≥5 时自动修正 0.8×window 阈值。
      calibrator: calibration,
      // 显式 `compactionMaxTokens` = 钉死预算 ⇒ 不传窗口；未配置时挂真实窗口（恒为正）。
      ...(runtime.config.compactionMaxTokens === undefined
        ? { contextWindowTokens: AgentCompactor.resolveContextWindow(runtime) }
        : {}),
    });
    // G8（2026-10-03）：token 记账**默认走 TS**，原生下沉改为显式开启（本机实测原生慢 4.5–6.7×）。
    if (NativeTokenAccounting.enabled(runtime.config.nativeTokenAccounting)) {
      const kernel = runtime.native;
      if (kernel?.estimateTokens !== undefined) {
        compactor.setNativeEstimator((m) => kernel.estimateTokens!(m));
      }
    }
    return compactor;
  }

  /**
   * 解析上下文窗口 token 数（UI 容量面板的百分比分母）。
   *
   * env `OMNI_CONTEXT_WINDOW` 优先（运维可显式纠正厂商表），否则按模型名查目录。
   * 与压缩阈值口径**有意分离**：窗口大小只是展示口径，不绑定折叠时机。
   * @param runtime 运行时组合根。
   * @returns 上下文窗口 token 数。
   */
  public static resolveContextWindow(runtime: OmniHarnessRuntime): number {
    const fromEnv = Number(process.env.OMNI_CONTEXT_WINDOW);
    return new ContextWindowCatalog(Number.isFinite(fromEnv) ? fromEnv : undefined).of(
      runtime.model.name,
    );
  }
}
