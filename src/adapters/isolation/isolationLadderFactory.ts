/**
 * 隔离阶梯的**生产装配工厂**（J8：让 `wasm` 档在真实路径上可达）。
 *
 * ## 为什么需要它
 *
 * 阶梯本身**故意不内置**任何档位执行器（"谁提供运行时"是部署决策），代价是：**每个构造点都要自己注入**
 * ——漏一处，那一处的 `wasm` 档就静默退化为 `level-unavailable`（fail-closed 但**功能不可达**，
 * 而且症状只是"装包被拒"，排查方向会跑偏）。所以把"本仓默认的后端组合"收在**一个**工厂里：
 * 构造点只写 `IsolationLadderFactory.builtin()`，后端清单只此一处。
 *
 * ## 当前内置后端
 *
 * | 档 | 后端 | 说明 |
 * | --- | --- | --- |
 * | `in-process` / `vm` | 阶梯自带 | 同上（`vm` 是 best-effort，**不是**安全边界，沿既有口径） |
 * | `wasm` | {@link BuiltinWasmRunner} | Node 内置 `WebAssembly` + Worker 硬超时；**零新依赖** |
 * | `os-sandbox` | **不注入** | 需平台原生能力，缺省不可达（拒绝而非降档，沿既有口径） |
 *
 * ## 与"装配下限"的边界（别把两件事混了）
 *
 * 能力栈的**默认装配下限**仍是 `{ trustTier: 'evolved', isolation: 'vm' }`（见
 * `CapabilityStackAssembler`）：把下限直接改成 `wasm` 会让**一切 JS 资产的载荷形态不再匹配**
 * （wasm 档只接受 `wasm-module`）——那是产品决策，不是本工厂该顺手做的。
 * 本工厂只负责"**声明了 wasm 的资产确实能在 wasm 档跑**"。
 *
 * @maturity L1 — 生产装配后 wasm 档可达且越界仍被拒 / 未注入档位仍 fail-closed 判据钉死
 * @maturityEvidence tests/unit/builtinWasmRunner.test.ts
 */
import { BuiltinWasmRunner } from './builtinWasmRunner.js';
import { IsolationLadder } from './isolationLadder.js';
import type { IsolationLadderOptions } from './isolationLadder.js';

/** 隔离阶梯装配工厂。 */
export class IsolationLadderFactory {
  private constructor() {}

  /**
   * 造一个带**本仓内置后端**的阶梯（`wasm` 档可达；`os-sandbox` 仍需外部注入）。
   * @param opts 阶梯选项（`wasmRunner` 由本工厂提供，传了也会被覆盖——后端清单只此一处）
   * @returns 阶梯实例
   */
  public static builtin(opts: Omit<IsolationLadderOptions, 'wasmRunner'> = {}): IsolationLadder {
    const runner = new BuiltinWasmRunner();
    return new IsolationLadder({ ...opts, wasmRunner: (request) => runner.run(request) });
  }
}
