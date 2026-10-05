/**
 * 内置 wasm 执行器（**J8** 的 `wasm` 隔离档实现；**零新依赖**：只用 Node 内置 `WebAssembly` + Worker）。
 *
 * ## 判据原文与本文的对应（`EVOLVIX_SPEC_2026-10.md` §8）
 *
 * > **J8** 隔离逃逸：`evolved` 档 wasm 内**越界访问** / **超 fuel** ⇒ **拒执行且 reason 可读**；
 * > 变异方向「**关 fuel metering ⇒ 红**」。
 *
 * | 判据 | 本实现如何满足 |
 * | --- | --- |
 * | 越界访问 | wasm 的 OOB 访问抛 `RuntimeError` ⇒ 映射为 `trap` 拒绝，reason 原样透出（含 "out of bounds"） |
 * | 超 fuel | **Worker 线程硬超时 + `terminate()`** ⇒ `timeout` 拒绝；`terminate` 是唯一能真正中止 wasm 的手段 |
 * | 关 fuel metering ⇒ 红 | **无预算即拒执行**：`fuel` 缺省 / `0` / 负数一律 `payload-unsupported` 拒绝，**绝不"不计量就跑"** |
 * | 拒执行且 reason 可读 | 四类拒绝各带点名原因（import 名 / 入口名 / 越界原因 / 预算值） |
 *
 * ## 与 wasmtime 的**诚实差别**（不许含糊）
 *
 * 本档的预算是**墙钟超时**，不是**指令级 fuel**：V8 不暴露 fuel 计量，宿主无法按指令数计费。
 * 差别在语义上真实存在（同一模块在不同机器上"能跑完的指令数"不同），故：
 * - 文档与拒绝原因里都写明「时间预算」，**不声称做了指令级 fuel 计量**；
 * - `fuel` 字段被解释为"**必须显式声明存在预算**"的开关（>0 即视为已声明），真实生效量是 `timeoutMs`；
 * - 若日后准入 `wasmtime`，替换本实现即可——`IsolationPort` 的对外语义不变。
 *
 * ## 其余三条强制
 *
 * 1. **默认拒绝全部 import**（在 worker 侧判定，见其模块注释）；
 * 2. **内存硬上限**：worker `resourceLimits.maxOldGenerationSizeMb`（缺省 64 MiB）；
 * 3. **worker 崩溃（OOM 等）也按 `trap` 拒**，不把"进程死了"当成功。
 *
 * @maturity L1 — 正例 / 越界 trap / 超预算 timeout 且真中止 / 无预算拒 / 全 import 拒 / 空字节拒 判据钉死
 * @maturityEvidence tests/unit/builtinWasmRunner.test.ts
 */
import { Worker } from 'node:worker_threads';
import { WASM_PAGE_BYTES, WasmMemoryLimits } from './wasmMemoryLimits.js';
import type {
  IsolationDenial,
  IsolationRequest,
  IsolationResult,
} from '../../ports/runtime/isolation.js';
import type { BuiltinWasmWorkerMessage } from './builtinWasmWorker.js';

/** wasm 执行器选项。 */
export interface BuiltinWasmRunnerOptions {
  /** 缺省超时（毫秒；缺省 2000）。**这是本档真正生效的预算形式**（见模块注释的差别说明）。 */
  readonly timeoutMs?: number | undefined;
  /** worker 堆上限（MiB；缺省 64）。 */
  readonly maxHeapMb?: number | undefined;
  /** 模块字节上限（缺省 16 MiB）。 */
  readonly maxModuleBytes?: number | undefined;
  /** C-ABI 入参上限（缺省 1 MiB）。 */
  readonly maxInputBytes?: number | undefined;
  /** 返回值上限（缺省 8 MiB）。 */
  readonly maxOutputBytes?: number | undefined;
  /**
   * 模块**线性内存**上限（MiB；缺省 256）。
   *
   * 与 `maxHeapMb` 的区别很重要：后者只约束 **V8 堆**，而 **wasm 线性内存不占 V8 堆**
   * ——只设堆上限挡不住"声明 4 GiB 内存"的模块。故这里在**实例化之前**读模块的 memory 段
   * （`WasmMemoryLimits`）：**未声明上限**（可无限 grow）或超出本值 ⇒ 直接拒执行。
   */
  readonly maxMemoryMb?: number | undefined;
}

/** 判定为"无预算"的 `fuel` 取值（`0` 按端口契约即"不计量"，本档**不接受**不计量执行）。 */
const NO_BUDGET_FUEL = 0;

/**
 * 模块字节上限（缺省 16 MiB）：本仓真内核 206 KB，留两个数量级余量。
 *
 * 为什么必须有：`WebAssembly.compile` 会在 worker 里按模块规模分配，一个 1 GiB 的"模块"
 * 能在预算耗尽前就把进程拖垮——**上限属于"边界与资源硬上限"（§12.1-3），不是优化**。
 */
export const DEFAULT_MAX_MODULE_BYTES = 16 * 1024 * 1024;

/** C-ABI 入参上限（缺省 1 MiB）：入参要**写进 wasm 线性内存**，无上限等于把内存交给调用方。 */
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

/** 返回值上限（缺省 8 MiB）：模块可以返回任意 (ptr,len)，无上限等于让它决定宿主读多少。 */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 模块线性内存上限（缺省 256 MiB）：**不占 V8 堆**，故必须单独卡（见 `WasmMemoryLimits`）。 */
const DEFAULT_MAX_MEMORY_MB = 256;

/** 内置 wasm 执行器（可注入 `IsolationLadder` 的 `wasmRunner`）。 */
export class BuiltinWasmRunner {
  /** 缺省超时（毫秒）。 */
  private readonly timeoutMs: number;
  /** worker 堆上限（MiB）。 */
  private readonly maxHeapMb: number;
  /** 模块字节上限。 */
  private readonly maxModuleBytes: number;
  /** C-ABI 入参上限。 */
  private readonly maxInputBytes: number;
  /** 返回值上限。 */
  private readonly maxOutputBytes: number;
  /** 模块线性内存上限（字节）。 */
  private readonly maxMemoryBytes: number;

  /**
   * @param opts 缺省超时与堆上限
   */
  public constructor(opts: BuiltinWasmRunnerOptions = {}) {
    this.timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 2000));
    this.maxHeapMb = Math.max(8, Math.floor(opts.maxHeapMb ?? 64));
    this.maxModuleBytes = Math.max(1, Math.floor(opts.maxModuleBytes ?? DEFAULT_MAX_MODULE_BYTES));
    this.maxInputBytes = Math.max(1, Math.floor(opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES));
    this.maxOutputBytes = Math.max(1, Math.floor(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));
    this.maxMemoryBytes =
      Math.max(1, Math.floor(opts.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB)) * 1024 * 1024;
  }

  /**
   * 在 wasm 隔离内执行载荷（`wasm-module` 专用）。
   * @param request 请求（`payload` 必须是 `wasm-module`）
   * @returns 执行结果或可读拒因
   */
  public async run<T>(request: IsolationRequest<T>): Promise<IsolationResult<T>> {
    if (request.payload.kind !== 'wasm-module') {
      return BuiltinWasmRunner.deny('payload-unsupported', 'wasm 档只接受 wasm-module 载荷');
    }
    const { bytes, fuel, entry, input } = request.payload;
    // ① 预算门：无预算不执行（"关 fuel metering ⇒ 红"的落点）。
    if (fuel === undefined || fuel <= NO_BUDGET_FUEL) {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        `未声明执行预算（fuel=${String(fuel ?? 'undefined')}）：本档**不做无预算执行**——` +
          '无预算等于把不可信代码放进一个不会被中止的进程',
      );
    }
    if (bytes.length === 0) {
      return BuiltinWasmRunner.deny('payload-unsupported', 'wasm 模块字节为空');
    }
    // ② 模块字节上限（§12.1-3 边界与资源硬上限）：编译期就会按规模分配，无上限等于把进程交给调用方。
    if (bytes.length > this.maxModuleBytes) {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        `模块字节超限（${String(bytes.length)} > ${String(this.maxModuleBytes)}）：上限见 BuiltinWasmRunnerOptions.maxModuleBytes`,
      );
    }
    // ③ 入参上限：入参要写进 wasm 线性内存，无上限等于让调用方决定模块吃多少内存。
    if (input !== undefined && Buffer.byteLength(input, 'utf8') > this.maxInputBytes) {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        `入参超限（${String(Buffer.byteLength(input, 'utf8'))} > ${String(this.maxInputBytes)} 字节）：上限见 maxInputBytes`,
      );
    }
    // ④ **线性内存声明**检查（实例化**之前**）：V8 堆上限挡不住 wasm 内存 —— 它不占堆。
    //    未声明上限（可无限 grow）同样拒：把"能长多大"交给模块自己决定，等于没有上限。
    const memoryScan = WasmMemoryLimits.scan(bytes);
    if (!memoryScan.ok) {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        `模块内存声明不可解析：${memoryScan.reason}`,
      );
    }
    const declared = memoryScan.memories.find((memory) => memory.maxPages === undefined);
    if (declared !== undefined) {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        '模块声明了**无上限**线性内存（limits 未给 max ⇒ 可无限 grow）：本档要求内存有上限，拒绝执行',
      );
    }
    const worst = memoryScan.memories.reduce(
      (bytesMax, memory) => Math.max(bytesMax, (memory.maxPages ?? 0) * WASM_PAGE_BYTES),
      0,
    );
    if (worst > this.maxMemoryBytes) {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        `模块声明内存超限（${String(worst)} > ${String(this.maxMemoryBytes)} 字节）：上限见 maxMemoryMb`,
      );
    }
    const timeoutMs = Math.max(1, Math.floor(request.timeoutMs ?? this.timeoutMs));
    return this.runInWorker<T>(bytes, entry, timeoutMs, input);
  }

  /**
   * 在 worker 线程里执行，到点强制终止。
   * @param bytes 模块字节
   * @param entry 入口导出名（缺省由 worker 挑第一个函数导出）
   * @param timeoutMs 时间预算（毫秒）
   * @returns 执行结果或拒因
   */
  private async runInWorker<T>(
    bytes: Uint8Array,
    entry: string | undefined,
    timeoutMs: number,
    input: string | undefined,
  ): Promise<IsolationResult<T>> {
    const worker = new Worker(new URL('./builtinWasmWorker.js', import.meta.url), {
      workerData: {
        bytesBase64: Buffer.from(bytes).toString('base64'),
        ...(entry !== undefined ? { entry } : {}),
        // 给了入参 ⇒ worker 走 C-ABI（omni_alloc → 入口(ptr,len) → 读回 → omni_dealloc）。
        ...(input !== undefined ? { input } : {}),
        // 返回值上限下传 worker：读回**之前**判定（否则"先分配再检查"已经吃掉了内存）。
        maxOutputBytes: this.maxOutputBytes,
      },
      resourceLimits: { maxOldGenerationSizeMb: this.maxHeapMb },
    });
    return new Promise<IsolationResult<T>>((resolve) => {
      let settled = false;
      const finish = (result: IsolationResult<T>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // 到点必须**真的**中止：`terminate()` 是唯一能打断 wasm 执行的手段。
        void worker.terminate();
        finish(
          BuiltinWasmRunner.deny(
            'timeout',
            `超出执行预算（时间预算 ${String(timeoutMs)}ms；本档无指令级 fuel 计量，以时间预算为准）——已强制终止`,
          ),
        );
      }, timeoutMs);
      worker.on('message', (message: BuiltinWasmWorkerMessage) => {
        finish(BuiltinWasmRunner.translate<T>(message));
      });
      worker.on('error', (err: Error) => {
        // worker 自身崩（OOM / 内部错误）也按拒处理：绝不把"进程死了"当成功。
        finish(BuiltinWasmRunner.deny('trap', `执行线程异常：${err.message}`));
      });
      worker.on('exit', (code: number) => {
        // 正常路径由 `message` 结算；到这里还悬着 ⇒ 线程非正常退出。
        if (!settled && code !== 0) {
          finish(BuiltinWasmRunner.deny('trap', `执行线程非正常退出（exit ${String(code)}）`));
        }
      });
    });
  }

  /**
   * worker 消息 → 隔离结论。
   * @param message worker 回传消息
   * @returns 隔离结论
   */
  private static translate<T>(message: BuiltinWasmWorkerMessage): IsolationResult<T> {
    if (message.kind === 'ok') {
      return { ok: true, value: message.value as T, level: 'wasm' };
    }
    if (message.kind === 'imports-denied') {
      return BuiltinWasmRunner.deny(
        'payload-unsupported',
        `模块声明了 import（${message.imports.join(', ')}）：wasm 档默认拒绝全部宿主能力，不提供也不假装提供`,
      );
    }
    if (message.kind === 'entry-missing') {
      return BuiltinWasmRunner.deny('payload-unsupported', `未找到可调用入口：${message.entry}`);
    }
    // 越界访问（`RuntimeError: memory access out of bounds`）/ `unreachable` / 编译失败都到这里。
    return BuiltinWasmRunner.deny('trap', message.reason);
  }

  /**
   * 造一条拒绝结论。
   * @param code 拒因分类
   * @param reason 可读原因
   * @returns 拒绝结论
   */
  private static deny<T>(code: IsolationDenial['code'], reason: string): IsolationResult<T> {
    // `IsolationDenial` 要求带档位：拒因必须说清「在哪一档被拒」，否则上层归因会误导。
    return { ok: false, denied: { code, level: 'wasm', reason } };
  }
}
