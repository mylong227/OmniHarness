/**
 * 资产类型注册表（ADR-0009 · EVOLVIX_SPEC §3 的 L1 实现）。
 *
 * 内存 `Map<kind, CapabilitySchema>` + **fail-closed 两条**（端口契约的落实）：
 * - 重复 `kind` 注册 ⇒ 抛错（静默覆盖会让已入库资产的校验口径变形，这类变形只会在很久以后
 *   以「某些资产莫名其妙过不了校验」的形式暴露）；
 * - 未注册 `kind` 查询 ⇒ 抛错（返回 `undefined` 会诱导调用方「跳过校验」，那正是 J7 漏洞的入口）。
 *
 * 无状态副作用：不读墙钟、不落盘、不联网——类型注册表是纯内存协议面（落盘的是台账与资产包，Wave D）。
 *
 * @maturity L1 — 注册/查询/确定性列举的行为判据钉死（含两条 fail-closed 的变异）
 * @maturityEvidence tests/unit/capabilitySchemaRegistry.test.ts
 */
import type { CapabilitySchema, CapabilitySchemaRegistryPort } from '../ports/capability.js';

/** 资产类型注册表：类型键 → 描述符（唯一权威）。 */
export class CapabilitySchemaRegistry implements CapabilitySchemaRegistryPort {
  /** 已注册描述符（插入序即注册序，供确定性列举）。 */
  private readonly schemas = new Map<string, CapabilitySchema>();

  /**
   * 注册一种资产类型描述符。
   * @param schema 类型描述符
   * @returns 无返回值（void）
   * @throws 重复 `kind` 时抛错（fail-closed）
   */
  public register(schema: CapabilitySchema): void {
    if (this.schemas.has(schema.kind)) {
      throw new Error(`资产类型重复注册: ${schema.kind}`);
    }
    this.schemas.set(schema.kind, schema);
  }

  /**
   * 取某类型的描述符。
   * @param kind 类型键
   * @returns 该类型的描述符
   * @throws 未注册的 `kind` 抛错（fail-closed）
   */
  public schemaOf(kind: string): CapabilitySchema {
    const schema = this.schemas.get(kind);
    if (schema === undefined) {
      throw new Error(`资产类型未注册: ${kind}（先 register 类型描述符，再入库该类型资产）`);
    }
    return schema;
  }

  /**
   * 是否已注册某类型。
   * @param kind 类型键
   * @returns 已注册为 true
   */
  public has(kind: string): boolean {
    return this.schemas.has(kind);
  }

  /**
   * 已注册类型键（**升序**：确定性与观测可对照）。
   * @returns 类型键列表
   */
  public kinds(): readonly string[] {
    return [...this.schemas.keys()].sort();
  }
}
