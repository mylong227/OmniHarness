/**
 * `wasm-skill` 资产类型（**Wave C 产品工作**：让 `evolved` 档的进化产物**能装成 wasm 技能包**）。
 *
 * ## 它补的是哪一段
 *
 * J8 落地后 `wasm` 隔离档**可用**（`BuiltinWasmRunner`），端到端也能跑真内核；但"资产"这一层此前
 * 没有任何类型**承载 wasm 字节**——于是 `evolved` 档的默认装配下限只能停在 `vm`（改成 `wasm` 会让
 * 一切 JS 载荷被正确拒绝 ⇒ 全坏）。本类型就是那个载体：资产体里放 wasm 模块（base64）+ C-ABI 元数据，
 * 声明 `defaultIsolation: 'wasm'`。
 *
 * ## 三条设计取舍（都有判据）
 *
 * 1. **模块用 base64 放在资产体里**，而不是"包内文件路径"：资产包（ADR-0011）的 `asset` 是**自包含**的
 *    —— 把它换成路径引用，就会让"装完之后资产还依赖包内文件在不在"，而包目录是可清理的（装完即删）。
 * 2. **`input` 与 `entry` 一起进资产体**：冒烟与运行时用的是**同一份**元数据，否则"装的是一套、跑的是另一套"。
 * 3. **`validate` 严格**：base64 必须能解、解出的字节必须以 wasm 魔数开头、`entry` 非空——
 *    一个"看起来像技能但装了跑不了"的资产，代价远高于当场拒绝。
 *
 * @maturity L1 — 合法体通过 / 非 wasm 字节拒 / base64 非法拒 / 缺 entry 拒 / 默认档位为 evolved+wasm 判据钉死
 * @maturityEvidence tests/unit/wasmSkillPack.test.ts
 */
import type {
  AssetBenchmark,
  CapabilitySchema,
  EvalContext,
  SchemaValidation,
} from '../../ports/capability.js';

/** wasm 技能资产体。 */
export interface WasmSkillAsset {
  /** 技能名（进注册表，唯一）。 */
  readonly name: string;
  /** 人类可读描述。 */
  readonly description: string;
  /** wasm 模块字节（base64；`Uint8Array` 不适合 JSON 往返）。 */
  readonly moduleBase64: string;
  /** C-ABI 入口导出名（缺省 `process`）。 */
  readonly entry?: string | undefined;
  /** 传给入口的字符串入参（缺省 `{"method":"ping"}`；冒烟与运行时共用这一份）。 */
  readonly input?: string | undefined;
  /** 执行预算（fuel；本档解释为"须显式声明预算"，真实生效量是运行时的超时）。 */
  readonly fuel?: number | undefined;
}

/** wasm 魔数（`\0asm`）。 */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** `wasm-skill` 资产类型。 */
export class WasmSkillSchema implements CapabilitySchema {
  /** 类型标识。 */
  public readonly kind = 'wasm-skill';
  /** 类型版本。 */
  public readonly version = 1;
  /**
   * 默认信任档：`evolved`——进化产物（与能力栈的装配下限同源）。
   */
  public readonly defaultTrustTier = 'evolved' as const;
  /**
   * 默认隔离档：`wasm`——本类型的**全部意义**就是"能被 wasm 档执行"。
   */
  public readonly defaultIsolation = 'wasm' as const;
  /** 台账语义（复用晋升链与全量快照）。 */
  public readonly ledgerSemantics = { chain: 'promotion', snapshot: 'registry-full' } as const;

  /**
   * 结构校验：名字/描述非空、base64 合法且是 wasm 字节、入口名非空。
   * @param asset 待校验资产
   * @returns 校验结论（失败带可行动原因）
   */
  public validate(asset: unknown): SchemaValidation {
    if (typeof asset !== 'object' || asset === null) {
      return { ok: false, reason: 'wasm 技能资产必须是对象' };
    }
    const record = asset as Partial<WasmSkillAsset>;
    for (const field of ['name', 'description'] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, reason: `wasm 技能字段 ${field} 缺失或为空` };
      }
    }
    if (typeof record.moduleBase64 !== 'string' || record.moduleBase64.trim() === '') {
      return { ok: false, reason: 'wasm 技能缺 moduleBase64（模块字节不得为空）' };
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(record.moduleBase64, 'base64');
    } catch {
      return { ok: false, reason: 'moduleBase64 不是合法 base64' };
    }
    if (bytes.length < 8 || !WASM_MAGIC.every((byte, index) => bytes[index] === byte)) {
      return { ok: false, reason: 'moduleBase64 解出的字节不是 wasm 模块（魔数不符）' };
    }
    if (
      record.entry !== undefined &&
      (typeof record.entry !== 'string' || record.entry.trim() === '')
    ) {
      return { ok: false, reason: 'entry 若给出必须是非空字符串（C-ABI 入口名）' };
    }
    if (record.input !== undefined && typeof record.input !== 'string') {
      return { ok: false, reason: 'input 若给出必须是字符串（传给入口的正文）' };
    }
    if (record.fuel !== undefined && (typeof record.fuel !== 'number' || record.fuel <= 0)) {
      return { ok: false, reason: 'fuel 若给出必须是正数（本档不做无预算执行）' };
    }
    return { ok: true };
  }

  /**
   * 评估合同：本类型的"好坏"不由结构单独决定——**能不能在 wasm 档真跑起来**才是关键，
   * 而那一环由装配期的隔离冒烟负责（跑不起来 ⇒ 装不上）。
   *
   * 度量口径（0..1）：结构合法 = 0.5；声明了入口 = +0.25；声明了预算 = +0.25。
   * 这里**不假装知道模块能否执行**（那要真执行，属冒烟那一步）——两个判据分工明确、不互相冒充。
   * @param _ctx 评估上下文（本类型的度量不看上下文：结构齐备度与上下文无关）
   * @returns 基准函数（资产 → 0..1）
   */
  public evalContract(_ctx: EvalContext): AssetBenchmark {
    return (asset: unknown): number => {
      if (!this.validate(asset).ok) return 0;
      const record = asset as WasmSkillAsset;
      let score = 0.5;
      if (record.entry !== undefined) score += 0.25;
      if (record.fuel !== undefined) score += 0.25;
      return score;
    };
  }
}
