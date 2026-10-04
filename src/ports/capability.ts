/**
 * 统一资产协议端口桶（ADR-0009 · EVOLVIX_SPEC §2）。
 *
 * 六个契约各自独立成文件于 `./capability/`，本文件只做桶导出（与 `ports/runtime/evolution.ts`
 * 同一形态：调用点零改动、按需深引）。端口恒第三方-free、零实现类（`arch:gate` [3] 强制）。
 */
export type { TrustTier } from './capability/trustTier.js';
export { TRUST_TIER_ORDER } from './capability/trustTier.js';
export type { IsolationLevel } from './capability/isolationLevel.js';
export { ISOLATION_LEVEL_ORDER } from './capability/isolationLevel.js';
export type {
  AssetBenchmark,
  CapabilitySchema,
  EvalContext,
  SchemaValidation,
} from './capability/capabilitySchema.js';
export type {
  CapabilityFitness,
  CapabilityGovernance,
  CapabilityLineage,
  CapabilityRecord,
} from './capability/capabilityRecord.js';
export type { CapabilitySchemaRegistryPort } from './capability/capabilitySchemaRegistryPort.js';
export type {
  CapabilityRegistryPort,
  GovernancePatch,
} from './capability/capabilityRegistryPort.js';
