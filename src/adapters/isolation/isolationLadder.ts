/**
 * 信任-隔离阶梯实现（Wave C · ADR-0010）：`IsolationPort` 的落地。
 *
 * ## 每一档的**真实**行为与边界（不吹牛版）
 *
 * | 档位              | 状态        | 做什么                                                                                     |
 * | ----------------- | ----------- | ------------------------------------------------------------------------------------------ |
 * | `in-process`      | ✅ 可用     | 直接调用（**逐位等价**：同一闭包在档内跑出的结果与直接调用完全一致）                        |
 * | `vm`              | ✅ best-effort | `node:vm` 受限上下文 + **V8 vm timeout**（能真正打断同步死循环）；禁 `require`/`process`/… |
 * | `os-sandbox`      | ⚠️ 需注入   | 由组合根注入档位原生执行器（`osRunner`）；未注入 ⇒ `level-unavailable`（不假装有 OS 沙箱） |
 * | `wasm`            | ❌ 不可达   | 本仓尚无 wasm 运行时（wasmtime 未按 D10 准入）⇒ 一律 `level-unavailable`，**不静默降档**   |
 *
 * **诚实标注（沿 ADR-0006 与 `plugin/sandbox.ts` 的既有表述）**：`node:vm` **不是**安全边界，
 * 只是「让普通资产代码够不到宿主」的 best-effort 约束；跨过首个 `await` 之后的同步死循环
 * 无法就地中止（V8 的终止只覆盖 `runInContext` 期间）。真要挡对抗性代码，得用 wasm 或独立进程。
 *
 * @maturity L1 — 四档行为与三条 fail-closed（不可达拒 / 只可收紧 / 逃逸即拒）判据钉死
 * @maturityEvidence tests/unit/isolationLadder.test.ts
 */
import { Script, createContext } from 'node:vm';
import { ISOLATION_LEVEL_ORDER } from '../../ports/capability.js';
import type { IsolationLevel } from '../../ports/capability.js';
import type {
  IsolationDenial,
  IsolationPort,
  IsolationRequest,
  IsolationResult,
} from '../../ports/runtime/isolation.js';

/** 默认 vm 超时（同步段；与插件沙箱同量级）。 */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * 档位原生执行器（`os-sandbox` 由组合根注入；缺省 = 该档不可达）。
 *
 * 返回 `unknown` 而非泛型 `T`：执行器在**另一个执行域**里跑，它无从知道调用方的 `T`——
 * 结果由阶梯按调用方声明的 `T` 搬回（这是一处**边界断言**，与「假隔离」不同：
 * 隔离确实发生在执行器那一侧，这里只是把结果取回来）。
 */
export type OsSandboxRunner = (request: IsolationRequest<unknown>) => Promise<unknown>;

/** 阶梯装配项。 */
export interface IsolationLadderOptions {
  /**
   * 允许「比资产声明更松」的档位（**默认 false**）。
   *
   * 默认关的理由：档位放宽必须有**显式**配置路径（ADR-0009 决策 6 / ADR-0010 决策 3），
   * 否则「signed 资产实际跑在进程内」这种事会被静默隐藏。
   */
  readonly allowDowngrade?: boolean | undefined;
  /** `os-sandbox` 档的原生执行器（注入即该档可达；缺省不可达）。 */
  readonly osRunner?: OsSandboxRunner | undefined;
  /** 默认超时（毫秒；缺省 5000）。 */
  readonly timeoutMs?: number | undefined;
}

/** 信任-隔离阶梯：按档位执行载荷，不可达即拒（绝不降档）。 */
export class IsolationLadder implements IsolationPort {
  /** 是否允许显式放宽档位。 */
  private readonly allowDowngrade: boolean;
  /** OS 沙箱档的原生执行器。 */
  private readonly osRunner?: OsSandboxRunner | undefined;
  /** 默认超时。 */
  private readonly timeoutMs: number;

  /**
   * @param opts 放宽开关 / OS 沙箱执行器 / 默认超时
   */
  public constructor(opts: IsolationLadderOptions = {}) {
    this.allowDowngrade = opts.allowDowngrade === true;
    this.osRunner = opts.osRunner;
    this.timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * 某档位是否可达（供组合根与 CLI 如实申报能力边界）。
   * @param level 档位
   * @returns 可达为 true
   */
  public available(level: IsolationLevel): boolean {
    if (level === 'in-process' || level === 'vm') return true;
    if (level === 'os-sandbox') return this.osRunner !== undefined;
    return false;
  }

  /**
   * 在（至多请求档位的）隔离内执行载荷。
   * @param request 请求（资产 + 载荷 + 可选档位/超时）
   * @returns 执行结果或拒因
   */
  public async run<T>(request: IsolationRequest<T>): Promise<IsolationResult<T>> {
    const declared = request.asset.governance.isolation;
    const requested = request.level ?? declared;
    const denial = this.admit(requested, declared, request.payload.kind);
    if (denial !== undefined) return { ok: false, denied: denial };
    return this.execute(requested, request);
  }

  /**
   * 准入判定（三条 fail-closed 中的两条：只可收紧 + 档位/载荷可达性）。
   * @param requested 请求档位
   * @param declared 资产声明档位
   * @param payloadKind 载荷类型
   * @returns 拒因；放行时 undefined
   */
  private admit(
    requested: IsolationLevel,
    declared: IsolationLevel,
    payloadKind: 'closure' | 'js-source' | 'wasm-module',
  ): IsolationDenial | undefined {
    // ① 只可收紧：请求比声明更松 ⇒ 默认拒（放宽需组合根显式 allowDowngrade）。
    if (
      !this.allowDowngrade &&
      ISOLATION_LEVEL_ORDER.indexOf(requested) < ISOLATION_LEVEL_ORDER.indexOf(declared)
    ) {
      return {
        code: 'downgrade-not-allowed',
        level: requested,
        reason: `档位放松被拒：资产声明 ${declared}，请求 ${requested}（放宽需显式配置 allowDowngrade）`,
      };
    }
    // ② 档位可达性：不可达即拒，**不降档**。
    if (!this.available(requested)) {
      return {
        code: 'level-unavailable',
        level: requested,
        reason:
          requested === 'wasm'
            ? 'wasm 档不可达：本仓尚未接入 wasm 运行时（wasmtime 未按 D10 准入），拒绝执行而不静默降档'
            : `${requested} 档不可达：未注入该档的原生执行器，拒绝执行而不静默降档`,
      };
    }
    // ③ 载荷与档位匹配：宿主闭包无法跨 realm，在更严档位上执行只会得到「假隔离」。
    if (payloadKind === 'closure' && requested !== 'in-process') {
      return {
        code: 'payload-unsupported',
        level: requested,
        reason: `宿主闭包无法搬进 ${requested} 档（跨 realm 会得到假隔离）；请改用该档原生载荷`,
      };
    }
    if (payloadKind === 'wasm-module' && requested !== 'wasm') {
      return {
        code: 'payload-unsupported',
        level: requested,
        reason: `wasm 载荷需要 wasm 档，当前档位 ${requested} 不支持`,
      };
    }
    return undefined;
  }

  /**
   * 分派到档位执行。
   * @param level 生效档位
   * @param request 请求
   * @returns 执行结果
   */
  private async execute<T>(
    level: IsolationLevel,
    request: IsolationRequest<T>,
  ): Promise<IsolationResult<T>> {
    if (level === 'in-process') return this.runInProcess(request.payload as never);
    if (level === 'vm') return this.runInVm(request);
    if (level === 'os-sandbox') return this.runInOsSandbox(level, request);
    return {
      ok: false,
      denied: {
        code: 'level-unavailable',
        level,
        reason: `档位 ${level} 不可达：拒绝执行（不静默降档）`,
      },
    };
  }

  /**
   * `in-process` 档：直接调用（**逐位等价**是这一档的全部承诺）。
   *
   * 载荷抛错 ⇒ 归 `trap` 拒因（**绝不把异常透出去**：`run` 的契约是「要么结果、要么拒因」，
   * 让异常逃逸会让调用方（如装包冒烟）在多资产循环里半途中止，留下不一致状态）。
   * @param payload 载荷（闭包）
   * @returns 执行结果
   */
  private async runInProcess<T>(payload: {
    readonly kind: 'closure';
    readonly run: () => T | Promise<T>;
  }): Promise<IsolationResult<T>> {
    try {
      return { ok: true, value: await payload.run(), level: 'in-process' };
    } catch (err) {
      return {
        ok: false,
        denied: {
          code: 'trap',
          level: 'in-process',
          reason: `in-process 档载荷抛错：${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  /**
   * `vm` 档：受限上下文 + V8 vm timeout。
   * @param request 请求（载荷须为 `js-source`）
   * @returns 执行结果
   */
  private runInVm<T>(request: IsolationRequest<T>): IsolationResult<T> {
    const payload = request.payload;
    if (payload.kind !== 'js-source') {
      return {
        ok: false,
        denied: {
          code: 'payload-unsupported',
          level: 'vm',
          reason: `vm 档只接受 js-source 载荷（当前 ${payload.kind}）`,
        },
      };
    }
    // 受限全局：不注入 require / process / module / globalThis / fetch（与插件沙箱同口径）。
    const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const context = createContext(sandbox);
    try {
      const value = new Script(`(${payload.code}\n)`, {
        filename: payload.filename ?? 'isolation-vm',
      }).runInContext(context, { timeout: request.timeoutMs ?? this.timeoutMs });
      // 载荷必须**自求值**（写成 IIFE）：返回函数说明它没被执行，而且跨 realm 调用**不受**
      // `runInContext` 的 timeout 保护（同步死循环会直接挂住宿主）——这种载荷必须拒，不能收。
      if (typeof value === 'function') {
        return {
          ok: false,
          denied: {
            code: 'payload-unsupported',
            level: 'vm',
            reason:
              'vm 载荷必须自求值（写成 `(() => …)()`）：返回函数说明它未被 vm 执行，且跨 realm 调用不受 vm timeout 保护',
          },
        };
      }
      return { ok: true, value: value as T, level: 'vm' };
    } catch (err) {
      return { ok: false, denied: IsolationLadder.denialOfVmError(err) };
    }
  }

  /**
   * `os-sandbox` 档：交给组合根注入的原生执行器（本类不假装自己有 OS 沙箱）。
   * @param level 生效档位
   * @param request 请求
   * @returns 执行结果
   */
  private async runInOsSandbox<T>(
    level: IsolationLevel,
    request: IsolationRequest<T>,
  ): Promise<IsolationResult<T>> {
    if (this.osRunner === undefined) {
      return {
        ok: false,
        denied: {
          code: 'level-unavailable',
          level,
          reason: 'os-sandbox 档不可达：未注入原生执行器，拒绝执行而不静默降档',
        },
      };
    }
    try {
      const value = await this.osRunner(request as IsolationRequest<unknown>);
      return { ok: true, value: value as T, level };
    } catch (err) {
      return {
        ok: false,
        denied: {
          code: 'trap',
          level,
          reason: `os-sandbox 执行被拒：${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  /**
   * 判 vm 异常的性质：超时 / 逃逸（触达宿主能力）/ trap。
   * @param err 异常
   * @returns 拒因
   */
  private static denialOfVmError(err: unknown): IsolationDenial {
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out|timeout/i.test(message)) {
      return {
        code: 'timeout',
        level: 'vm',
        reason: `vm 档执行超时（同步段被 V8 中止）：${message}`,
      };
    }
    if (
      /require\s+is\s+not\s+defined|process\s+is\s+not\s+defined|Cannot find module/i.test(message)
    ) {
      return { code: 'escape', level: 'vm', reason: `vm 档执行试图触达宿主能力：${message}` };
    }
    return { code: 'trap', level: 'vm', reason: `vm 档执行异常：${message}` };
  }
}
