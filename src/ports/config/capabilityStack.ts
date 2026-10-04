import type {
  CapabilityRegistryPort,
  CapabilitySchemaRegistryPort,
  IsolationLevel,
  TrustTier,
} from '../capability.js';
import type { EvaluatorPort } from '../runtime/evolution.js';

/**
 * 统一资产协议切片（Wave B · ADR-0009）：L1 层装配产物，并入 `ResolvedConfig`。
 *
 * 为什么切片只暴露**端口**而不是实现类：组合根可以换成别的注册表/评估器实现
 * （这正是「协议」而不是「某个类」的意义），消费方（CLI / 后续的治理台）也不必认识具体类。
 */
export interface CapabilityStack {
  /** 类型注册表（内置已注册 `skill` / `workflow-template`）。 */
  readonly schemas: CapabilitySchemaRegistryPort;
  /** 统一资产注册表（内部持同一份技能表——绞杀者第一态）。 */
  readonly registry: CapabilityRegistryPort;
  /** 通用评估器（度量由类型声明，见 `CapabilitySchema.evalContract`）。 */
  readonly evaluator: EvaluatorPort;
  /** 生效的档位下限（配置与出厂下限取更严者；只收紧，见装配器文档）。 */
  readonly defaults: {
    /** 生效信任档。 */
    readonly trustTier: TrustTier;
    /** 生效隔离档。 */
    readonly isolation: IsolationLevel;
  };
}
