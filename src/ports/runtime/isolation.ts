/**
 * 隔离端口（Wave C · ADR-0010 / EVOLVIX_SPEC §6 信任-隔离矩阵的执行面）。
 *
 * ## 它解决什么
 *
 * Wave B 让资产**声明**了隔离档，但档位此前只是记录里的一个字段。本端口把它变成**执行时的门**：
 * 请求一个档位、带上载荷，拿回「跑了什么」或「为什么拒」。
 *
 * ## 为什么载荷要分派（而不是只收一个闭包）
 *
 * 宿主闭包**无法**跨 realm——它闭在宿主模块上，塞进 `node:vm` 只会得到**假的隔离**。
 * 因此端口按载荷分派：闭包 ⇒ 只允许 `in-process`；源码 ⇒ `vm`；wasm 字节 ⇒ `wasm`。
 * 在更严档位上请求闭包 ⇒ `payload-unsupported`（拒执行，不假装隔离）。
 *
 * ## 失败语义（fail-closed，三条都被判据钉住）
 *
 * 1. **档位不可达 ⇒ 拒绝执行**（`level-unavailable`）：例如本仓尚无 wasm 运行时（wasmtime 未准入）
 *    ⇒ 任何 `wasm` 档请求一律拒，**绝不静默降档**（沿 ADR-0006 诚实降级口径）；
 * 2. **只可收紧**：请求比资产声明更松 ⇒ `downgrade-not-allowed`（放宽必须由组合根显式配置）；
 * 3. **逃逸即拒**（`escape`）：受限上下文里能触达宿主能力（`require` / `process` / …）⇒ 拒执行并记因。
 */
import type { IsolationLevel } from '../capability/isolationLevel.js';
import type { CapabilityRecord } from '../capability/capabilityRecord.js';

/** 隔离执行请求的载荷（三型；见模块注释「为什么载荷要分派」）。 */
export type IsolationPayload<T> =
  | {
      /** 宿主闭包：**只允许** `in-process` 档（跨 realm 不可搬运）。 */
      readonly kind: 'closure';
      /** 实际要跑的逻辑。 */
      readonly run: () => T | Promise<T>;
    }
  | {
      /** JS 源码：在受限 vm 上下文里执行，表达式/IIFE 的返回值即结果。 */
      readonly kind: 'js-source';
      /** 源码文本（须自包含：不得 `require` / `import`）。 */
      readonly code: string;
      /** 用于错误定位的文件名。 */
      readonly filename?: string | undefined;
    }
  | {
      /** wasm 模块字节（+ fuel 预算）：需档位原生运行时。 */
      readonly kind: 'wasm-module';
      /** 模块字节。 */
      readonly bytes: Uint8Array;
      /** 导出入口名（缺省 `run`）。 */
      readonly entry?: string | undefined;
      /** fuel 预算（超限即拒执行；0 = 不计量，由档位实现决定是否接受）。 */
      readonly fuel?: number | undefined;
      /**
       * 传给入口的**字符串入参**（缺省 = 无参调用）。
       *
       * 有它时走 **C-ABI 宿主协议**：模块须导出 `omni_alloc(len) -> ptr`、
       * 入口 `(ptr, len) -> i64`（低 32 位 ptr、高 32 位 len）与 `omni_dealloc(ptr, len)`；
       * 宿主负责写内存 → 调用 → 读回 → 释放（协议见 `crates/omni-wasm` 的模块注释，
       * 那是本仓 wasm 内核的**既有 ABI**）。
       *
       * 为什么写进契约而不是让调用方自己拼内存：`wasm-module` 的唯一现实用途就是跑本仓
       * 编译出来的 wasm 内核，而它的入口签名恒定为 `process(ptr,len)`——不写进契约，
       * 每个调用方都要自己实现一遍内存读写，而"实现两遍"正是内存越界的来源。
       */
      readonly input?: string | undefined;
    };

/** 隔离执行请求。 */
export interface IsolationRequest<T> {
  /** 受治理资产（其 `governance.isolation` 是**下限**：请求只能更严）。 */
  readonly asset: CapabilityRecord;
  /** 载荷。 */
  readonly payload: IsolationPayload<T>;
  /**
   * 请求档位（缺省 = 资产声明的档位）。比资产声明**更松** ⇒ 默认拒（`downgrade-not-allowed`）。
   */
  readonly level?: IsolationLevel | undefined;
  /** 执行超时（毫秒；缺省由档位实现给保守值）。 */
  readonly timeoutMs?: number | undefined;
}

/** 拒绝原因（可机读的少数枚举 + 人类可读一句）。 */
export interface IsolationDenial {
  /** 拒因分类。 */
  readonly code:
    | 'level-unavailable'
    | 'payload-unsupported'
    | 'downgrade-not-allowed'
    | 'timeout'
    | 'trap'
    | 'escape';
  /** 可行动的原因说明（进日志与拒装报告）。 */
  readonly reason: string;
  /** 被请求的档位。 */
  readonly level: IsolationLevel;
}

/** 隔离执行结果（成功给值与生效档位；失败给拒因，绝不抛裸栈）。 */
export type IsolationResult<T> =
  | {
      /** 执行成功。 */
      readonly ok: true;
      /** 载荷的返回值。 */
      readonly value: T;
      /** 实际生效档位（可能比请求更严——收紧是允许的）。 */
      readonly level: IsolationLevel;
    }
  | {
      /** 执行被拒（fail-closed）。 */
      readonly ok: false;
      /** 拒因。 */
      readonly denied: IsolationDenial;
    };

/**
 * 隔离端口：按资产声明的档位执行载荷。
 *
 * 实现须：**确定性**（同输入同结论）、**不静默降档**、**每次给可读拒因**。
 */
export interface IsolationPort {
  /**
   * 在（至多请求档位的）隔离内执行载荷。
   * @param request 请求（资产 + 载荷 + 可选档位/超时）
   * @returns 执行结果或拒因
   */
  run<T>(request: IsolationRequest<T>): Promise<IsolationResult<T>>;
  /**
   * 某档位当前是否可达（供组合根/CLI 如实申报能力边界）。
   * @param level 档位
   * @returns 可达为 true
   */
  available(level: IsolationLevel): boolean;
}
