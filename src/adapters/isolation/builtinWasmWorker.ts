/**
 * wasm 执行 worker（`BuiltinWasmRunner` 的子进程侧；**J8** 的强制点在这里）。
 *
 * ## 为什么必须另起线程
 *
 * V8 的 `WebAssembly` **没有 fuel 计量**，也无法从宿主线程打断一个进入无限循环的实例
 * （`vm` 的 `timeout` 只覆盖 JS 脚本，管不到 wasm 执行）。故本档把"预算"落在**线程**上：
 * 主线程到点 `terminate()` —— 这是唯一能真正中止 wasm 的手段，也是本档称得上"隔离"的前提。
 *
 * ## 三条强制（fail-closed）
 *
 * 1. **默认拒绝全部 import**：模块只要声明了任何 import（`env.*` / WASI 等），一律拒绝执行
 *    ——"能不能触达宿主能力"不该由被隔离方声明决定；
 * 2. **超预算即被主线程终止**（本文件不负责计时；它只负责执行，超时由 {@link BuiltinWasmRunner} 处理）；
 * 3. **任何异常都回 `trap`**（含越界访问的 `RuntimeError`、编译失败、内存分配失败），
 *    并带上**可读原因**（J8 要求"拒执行且 reason 可读"）。
 *
 * ## 返回协议
 *
 * `{ kind:'ok', value }` / `{ kind:'trap', reason }` / `{ kind:'imports-denied', imports }` /
 * `{ kind:'entry-missing', entry }`。值一律转字符串（`i64` 是 bigint，结构化克隆到主线程后仍可用，
 * 但字符串更省事且不影响判据口径：本档证的是"跑没跑成"，不是"值是什么类型"）。
 */
import { parentPort, workerData } from 'node:worker_threads';

/**
 * 最小 `WebAssembly` 类型面（只声明本文件用到的三件事）。
 *
 * 为什么不直接依赖 DOM lib：主 tsconfig 的 `lib` 只有 `ES2024`（`@types/node` 也不声明 `WebAssembly`），
 * 为一个 worker 给整个 Node 项目引入 DOM 全局会**扩大所有文件的可用全局**（如 `document`、`window`）
 * ——那与本仓"类型面即约束"的一贯口径相反。故就地声明用到的那部分，范围最小、意图明确。
 */
interface WasmModuleFace {
  /** 模块 import 列表（用于"默认拒绝全部 import"的判定）。 */
  readonly imports?: never;
}

/** `WebAssembly.Module`（只用到静态 `imports`）。 */
interface WasmModuleCtor {
  imports(module: object): readonly { readonly module: string; readonly name: string }[];
}

/** wasm 线性内存（只用到 `buffer`）。 */
interface WasmMemoryFace {
  readonly buffer: ArrayBuffer;
}

/** `WebAssembly` 全局的最小面。 */
interface WasmApi {
  /** `WebAssembly.Memory`（用于 `instanceof` 判定与类型标注）。 */
  readonly Memory: new (descriptor: { readonly initial: number }) => WasmMemoryFace;
  readonly Module: WasmModuleCtor;
  compile(bytes: Uint8Array): Promise<object>;
  instantiate(
    module: object,
    imports: Record<string, never>,
  ): Promise<{ readonly exports: Record<string, unknown> }>;
}

/** 取 `WebAssembly` 全局（缺失即抛——本档在无该全局的环境下不可用，属环境缺陷而非静默降级）。 */
const wasm = (globalThis as unknown as { readonly WebAssembly?: WasmApi }).WebAssembly;
void (undefined as unknown as WasmModuleFace);

/** worker 入参（由 `builtinWasmRunner` 通过 `workerData` 传入）。 */
export interface BuiltinWasmWorkerData {
  /** 模块字节（base64；`Uint8Array` 不便于 `workerData` 往返，故编码传递）。 */
  readonly bytesBase64: string;
  /** 要调用的导出名（缺省挑第一个函数导出；C-ABI 模式下缺省 `process`）。 */
  readonly entry?: string | undefined;
  /**
   * 字符串入参（给出即走 **C-ABI 宿主协议**：`omni_alloc` → 写内存 → 入口(ptr,len) → 读回 → `omni_dealloc`）。
   */
  readonly input?: string | undefined;
}

/** worker 回传消息。 */
export type BuiltinWasmWorkerMessage =
  | { readonly kind: 'ok'; readonly value: string | null }
  | { readonly kind: 'trap'; readonly reason: string }
  | { readonly kind: 'imports-denied'; readonly imports: readonly string[] }
  | { readonly kind: 'entry-missing'; readonly entry: string };

/** wasm 执行 worker 主体。 */
export class BuiltinWasmWorker {
  private constructor() {}

  /**
   * C-ABI 调用：写内存 → 调入口 → 读回 → 释放（每一步的失败都回可读 `trap`）。
   *
   * 协议（与 `crates/omni-wasm` 一致）：`omni_alloc(len) -> ptr`、
   * 入口 `(ptr, len) -> i64`（低 32 位 ptr / 高 32 位 len）、`omni_dealloc(ptr, len)`。
   * @param exports 模块导出
   * @param data worker 入参（含 `input`）
   * @returns worker 回传消息
   */
  private static callWithInput(
    exports: Record<string, unknown>,
    data: BuiltinWasmWorkerData,
  ): BuiltinWasmWorkerMessage {
    const alloc = exports['omni_alloc'];
    const dealloc = exports['omni_dealloc'];
    const entryName = data.entry ?? 'process';
    const entry = exports[entryName];
    const memory = exports['memory'];
    // `memory` 必须是 wasm 线性内存：用**最小类型面**的构造器判定（主 tsconfig 无 DOM lib，
    // 故不能写 `instanceof WebAssembly.Memory`——那会把 DOM 全局拉进整个 Node 项目）。
    if (
      typeof alloc !== 'function' ||
      typeof entry !== 'function' ||
      memory === null ||
      typeof memory !== 'object' ||
      wasm === undefined ||
      !(memory instanceof wasm.Memory)
    ) {
      return {
        kind: 'trap',
        reason:
          'C-ABI 模式要求模块导出 omni_alloc / omni_dealloc / memory 与入口（默认 process）' +
          `；实际入口 ${entryName}=${typeof entry}`,
      };
    }
    const bytes = Buffer.from(data.input ?? '', 'utf8');
    const ptr = (alloc as (len: number) => number)(bytes.length);
    const memoryFace = memory as WasmMemoryFace;
    new Uint8Array(memoryFace.buffer, ptr, bytes.length).set(bytes);
    const packed = (entry as (ptr: number, len: number) => bigint | number)(ptr, bytes.length);
    // i64 返回：BigInt 与本仓 worker 的 i64 语义一致；低 32 位 ptr / 高 32 位 len。
    const value = typeof packed === 'bigint' ? packed : BigInt(packed);
    const outPtr = Number(value & 0xffffffffn);
    const outLen = Number((value >> 32n) & 0xffffffffn);
    const response = Buffer.from(new Uint8Array(memoryFace.buffer, outPtr, outLen)).toString(
      'utf8',
    );
    if (typeof dealloc === 'function') {
      (dealloc as (ptr: number, len: number) => void)(outPtr, outLen);
    }
    return { kind: 'ok', value: response };
  }

  /**
   * 执行载荷并回传结果（协议见模块注释）。
   * @returns 无返回值（结果经 `parentPort` 发出）
   */
  public static async main(): Promise<void> {
    const port = parentPort;
    if (port === null) return; // 非 worker 环境（被误 import）：静默返回，不抛。
    const data = workerData as BuiltinWasmWorkerData;
    try {
      if (wasm === undefined) {
        // 环境缺 `WebAssembly` 全局：如实拒绝，不静默降级（本档的全部保证都建立在它之上）。
        port.postMessage({
          kind: 'trap',
          reason: '运行环境缺 WebAssembly 全局（wasm 档不可用，不静默降级）',
        } satisfies BuiltinWasmWorkerMessage);
        return;
      }
      const bytes = Buffer.from(data.bytesBase64, 'base64');
      const module = await wasm.compile(bytes);
      const imports = wasm.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`);
      if (imports.length > 0) {
        // 默认拒绝全部 import：不提供任何宿主函数，也不假装提供。
        port.postMessage({ kind: 'imports-denied', imports } satisfies BuiltinWasmWorkerMessage);
        return;
      }
      const instance = await wasm.instantiate(module, {});
      const exports = instance.exports as Record<string, unknown>;
      // C-ABI 模式（给了入参）：走 omni_alloc/process/dealloc 协议，见 crates/omni-wasm 的 ABI 注释。
      if (data.input !== undefined) {
        port.postMessage(BuiltinWasmWorker.callWithInput(exports, data));
        return;
      }
      const entry =
        data.entry ?? Object.keys(exports).find((name) => typeof exports[name] === 'function');
      if (entry === undefined || typeof exports[entry] !== 'function') {
        port.postMessage({ kind: 'entry-missing', entry: data.entry ?? '(未找到函数导出)' });
        return;
      }
      const value = (exports[entry] as (...args: unknown[]) => unknown)();
      port.postMessage({
        kind: 'ok',
        value: value === undefined ? null : String(value),
      } satisfies BuiltinWasmWorkerMessage);
    } catch (err) {
      // 越界访问 / `unreachable` / 编译失败 / 内存不足都走这里：**如实**把原因交给上层。
      port.postMessage({
        kind: 'trap',
        reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      } satisfies BuiltinWasmWorkerMessage);
    }
  }
}

await BuiltinWasmWorker.main();
