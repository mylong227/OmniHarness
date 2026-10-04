/**
 * 资产类型注册表端口（ADR-0009 · EVOLVIX_SPEC §2；L1 协议的入口）。
 *
 * 失败语义（**fail-closed**，两条都是「拒」而不是「默认值」）：
 * - 重复 `kind` 注册 ⇒ 抛错（同一类型键只能有一个权威描述符，静默覆盖会让已入库资产的校验口径变形）；
 * - 未注册 `kind` 查询 ⇒ 抛错（调用方拿到 `undefined` 极易顺势「跳过校验」，那是 J7 漏洞的温床）。
 */
import type { CapabilitySchema } from './capabilitySchema.js';

/** 资产类型注册表。 */
export interface CapabilitySchemaRegistryPort {
  /**
   * 注册一种资产类型描述符。
   * @param schema 类型描述符
   * @returns 无返回值（void）
   * @throws 重复 `kind` 时抛错（fail-closed）
   */
  register(schema: CapabilitySchema): void;
  /**
   * 取某类型的描述符。
   * @param kind 类型键
   * @returns 该类型的描述符
   * @throws 未注册的 `kind` 抛错（fail-closed）
   */
  schemaOf(kind: string): CapabilitySchema;
  /**
   * 是否已注册某类型（供「先查再注册」的调用方与观测使用；不改变 `schemaOf` 的 fail-closed 语义）。
   * @param kind 类型键
   * @returns 已注册为 true
   */
  has(kind: string): boolean;
  /**
   * 已注册类型键（**升序**：确定性，供 CLI/观测与判据对照）。
   * @returns 类型键列表
   */
  kinds(): readonly string[];
}
