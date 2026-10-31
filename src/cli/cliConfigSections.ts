import type { CliArgs } from './argParser.ts';
import type { OmniHarnessConfig } from '../ports/config/omniHarnessConfig.ts';
import { CliDecisionEngineFlags } from './cliDecisionEngineFlags.ts';
import { EnforcementModeResolver } from '../security/enforcementModeResolver.ts';

/**
 * `CliBuildConfig.buildConfig` 的**对象字面量分段**协作类（2026-10-31 抽出；原方法 129 行、
 * 且宿主类贴上帝类方法数红线）。两段共同语义：「未显式配置 = 缺省关闭或观测档」。
 */
export class CliConfigSections {
  /**
   * 预算与护栏分段：模型重试 / 熔断三元组 / 回合 token 预算 / 成本预算三元组 /
   * 注入护栏 / 自验证 / 决策引擎。
   * @param args 解析后的 CLI 参数。
   * @returns 可展开进 ConfigFactory.build 的分段 partial。
   */
  public static budgetGuard(args: CliArgs): Partial<OmniHarnessConfig> {
    return {
      // V2.1（A3）：模型重试默认开——生产环境最蠢的单点故障是一次 429 报废整回合。
      // --no-model-retry 显式关闭；策略（3 次 / 500ms 指数退避 / 尊重 Retry-After）见 RetryingModel。
      modelRetry: args.modelRetry ?? true,
      // F3：模型熔断默认开——重试吸收单次调用的瞬时抖动，熔断识别「下游持续不可用」并短路
      // （冷却期不发起任何网络调用，冷却到期自动半开探测）。--no-model-circuit-breaker 关闭。
      modelCircuitBreaker: args.modelCircuitBreaker ?? true,
      ...(args.modelCircuitBreakerThreshold !== undefined
        ? { modelCircuitBreakerThreshold: args.modelCircuitBreakerThreshold }
        : {}),
      ...(args.modelCircuitBreakerOpenMs !== undefined
        ? { modelCircuitBreakerOpenMs: args.modelCircuitBreakerOpenMs }
        : {}),
      // V2.1（B4）：回合 token 预算（未设不进 config，维持缺省关闭语义）。
      ...(args.turnTokenBudget !== undefined && args.turnTokenBudget > 0
        ? { turnTokenBudget: args.turnTokenBudget }
        : {}),
      // (P5) 成本预算：此前 `costBudgetUsd` 仅能编程注入（配置文件与 CLI 均无入口）⇒ 默认部署
      // 下成本预算恒为关闭、`budget_status` 工具永不注册。此处补齐生产入口；
      // 未设正数则不写 config = 缺省关闭（零行为变更）。
      ...(args.costBudgetUsd !== undefined && args.costBudgetUsd > 0
        ? {
            costBudgetUsd: args.costBudgetUsd,
            ...(args.costBudgetOnExceed !== undefined
              ? { costBudgetOnExceed: args.costBudgetOnExceed }
              : {}),
            ...(args.costBudgetSoftRatio !== undefined
              ? { costBudgetSoftRatio: args.costBudgetSoftRatio }
              : {}),
          }
        : {}),
      // (D1) 护栏生效模式：显式 `--guard-prompt-injection-mode` 优先；否则 `--guard-prompt-injection`
      // 等价 `enforce`（历史语义保留）；两者皆未给 ⇒ **默认 `shadow`**（观测档常开：跑检测、记录、
      // 但原样放行，零误拦零行为回归，覆盖「默认关丢覆盖面」死结）。显式 `off` 可关回；库级默认
      // （ConfigFactory）仍 off，单测/嵌入方零行为。归一化见 `EnforcementModeResolver.fromCliArgs`。
      promptInjectionGuard: EnforcementModeResolver.fromCliArgs(
        args.guardPromptInjectionMode,
        args.promptInjectionGuard,
      ),
      // （P3→P1-⑨）自验证回环：**默认开启**（以「仓库能推断出测试命令」为前提；无证据的仓库
      // 自动不启用）。--no-self-verify 可显式关闭；预算取 SelfVerifyPolicy 默认。在**生产入口**
      // 默认开而不是改 ConfigFactory：库级默认保持「不装配即零行为」。
      selfVerify: args.selfVerify === false ? { enabled: false } : { enabled: true },
      // （Laya 战略线）决策引擎：**生产入口默认 shadow**（跑、记、不改行为），与护栏/自验证同口径
      // ——库级默认仍是 off。解释器与权重目录由适配器零配置解析。
      ...(() => {
        const decisionEngine = CliDecisionEngineFlags.resolve(args);
        return decisionEngine === undefined ? {} : { decisionEngine };
      })(),
    };
  }

  /**
   * 工具面分段：大输出外溢三元组 / 子代理三元组 / workers / native / planMode /
   * 延迟工具清单 / LSP / 记忆加密与密钥文件。
   * @param args 解析后的 CLI 参数。
   * @param built 依赖宿主实例方法产出的两个端口（workers / LSP 配置）。
   * @returns 可展开进 ConfigFactory.build 的分段 partial。
   */
  public static tooling(
    args: CliArgs,
    built: {
      readonly workers: OmniHarnessConfig['workers'];
      readonly lspServer: OmniHarnessConfig['lspServer'];
    },
  ): Partial<OmniHarnessConfig> {
    return {
      spillAdapter: args.spillAdapter,
      spillMaxInlineBytes: args.spillMax,
      spillPreviewBytes: args.spillPreview,
      subagentMaxDepth: args.subagentMaxDepth,
      subagentConcurrency: args.subagentConcurrency,
      subagentMaxSteps: args.subagentMaxSteps,
      workers: built.workers,
      native: args.native,
      planMode: args.planMode,
      deferredTools: args.deferTools
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      lspServer: built.lspServer,
      longTermMemoryEncryption: args.memoryEncrypt === true,
      longTermMemoryKeyFile: args.memoryKeyFile,
    };
  }
}
