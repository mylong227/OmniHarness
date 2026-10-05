/**
 * 资源硬上限判据（§12.1-3：**边界与资源硬上限**）——`BuiltinWasmRunner` + `WasmMemoryLimits`。
 *
 * ## 为什么单独一份判据
 *
 * `builtinWasmRunner.test.ts` 证的是**隔离语义**（越界/预算/import）；本文件证的是**资源面**：
 * 一个模块不能靠"声明 4 GiB 内存 / 返回 1 GiB 输出 / 塞 100 MB 入参"把宿主拖垮。
 * 这些**不是优化**：没有它们，"内存硬上限"只是注释里的一句话。
 *
 * 关键事实：worker 的 `resourceLimits` 只约束 **V8 堆**，而 **wasm 线性内存不占 V8 堆**——
 * 故必须在**实例化之前**读模块自己的 memory 段（`WasmMemoryLimits`），否则限制形同虚设。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BuiltinWasmRunner } from '../../src/adapters/isolation/builtinWasmRunner.js';
import {
  WASM_PAGE_BYTES,
  WasmMemoryLimits,
} from '../../src/adapters/isolation/wasmMemoryLimits.js';
import type { IsolationRequest } from '../../src/ports/runtime/isolation.js';

/**
 * 造段字节。
 * @param id 段 id
 * @param payload payload
 * @returns 段字节
 */
function section(id: number, payload: readonly number[]): number[] {
  return [id, payload.length, ...payload];
}

/**
 * 造一个声明线性内存的空模块（无函数）。
 * @param limits 内存 limits 字节（不含 flags 之后的 LEB）
 * @returns 模块字节
 */
function moduleWithMemory(limits: readonly number[]): Uint8Array {
  // 结构：type(1) func(3) memory(5) export(7) code(10)——**段序是规范硬约束**。
  // 入口 `run: () -> ()` 的体是 `locals=0, end`（2 字节），长度前缀写它的字节数。
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [1, 0x60, 0x00, 0x00]),
    ...section(3, [1, 0x00]),
    ...section(5, [1, ...limits]),
    ...section(7, [1, 3, ...Buffer.from('run'), 0x00, 0x00]),
    ...section(10, [1, 0x02, 0x00, 0x0b]),
  ]);
}

/**
 * 造一个"返回固定长度"的 C-ABI 模块（用于输出上限判据）。
 * 导出：memory(1 页)、omni_alloc(返回 0)、omni_dealloc(空)、process(返回 pack(0, outLen))。
 * @param outLen 声称的返回长度
 * @returns 模块字节
 */
function moduleReturning(outLen: number): Uint8Array {
  /** LEB128 编码（判据内部用，够覆盖小整数与 4 位量级）。 */
  const leb = (value: number): number[] => {
    const out: number[] = [];
    let rest = value;
    do {
      const byte = rest & 0x7f;
      rest >>>= 7;
      out.push(rest === 0 ? byte : byte | 0x80);
    } while (rest !== 0);
    return out;
  };
  const i32 = (value: number): number[] => [0x41, ...leb(value)];
  /**
   * 打包 `(ptr=0, len)` 为 i64 的有符号 LEB128（低 32 位 ptr / 高 32 位 len）。
   *
   * 判据第一版把 len 放在**低位** ⇒ 宿主读到的 len 恒为 0，上限自然不触发（夹具骗过了判据）。
   * @param len 声称的返回长度
   * @returns `i64.const` 指令字节
   */
  const i64packedLen = (len: number): number[] => {
    let rest = BigInt(len) << 32n;
    const out: number[] = [0x42];
    for (;;) {
      const byte = Number(rest & 0x7fn);
      rest >>= 7n;
      const signBit = (byte & 0x40) !== 0;
      if ((rest === 0n && !signBit) || (rest === -1n && signBit)) {
        out.push(byte);
        break;
      }
      out.push(byte | 0x80);
    }
    return out;
  };
  // 类型段：t0=()->i32（alloc），t1=()->()（dealloc），t2=()->i64（process）
  const types = section(1, [3, 0x60, 0x00, 0x01, 0x7f, 0x60, 0x00, 0x00, 0x60, 0x00, 0x01, 0x7e]);
  const funcs = section(3, [3, 0x00, 0x01, 0x02]);
  const memory = section(5, [1, 0x01, 0x01, 0x01]); // flags=1（有 max），min=1，max=1
  const exports = section(7, [
    4,
    6,
    ...Buffer.from('memory'),
    0x02,
    0x00, // memory 0
    10,
    ...Buffer.from('omni_alloc'),
    0x00,
    0x00,
    12,
    ...Buffer.from('omni_dealloc'),
    0x00,
    0x01,
    7,
    ...Buffer.from('process'),
    0x00,
    0x02,
  ]);
  const body = (locals: readonly number[], code: readonly number[]): number[] => {
    // 函数体 = 长度前缀 + locals 向量（**含计数字节**）+ 指令 + end。
    // 第一版把计数字节漏掉，编译期直接 `expected N bytes, fell off end`——长度前缀错一位就全错。
    const bytes = [locals.length, ...locals, ...code, 0x0b];
    return [bytes.length, ...bytes];
  };
  const code = section(10, [
    3,
    ...body([], i32(0)), // omni_alloc -> 0
    ...body([], []), // omni_dealloc -> ()
    ...body([], i64packedLen(outLen)), // process -> pack(ptr=0, len=outLen)
  ]);
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...types,
    ...funcs,
    ...memory,
    ...exports,
    ...code,
  ]);
}

/**
 * 造请求。
 * @param bytes 模块
 * @param opts 入参/fuel/超时
 * @returns 请求
 */
function requestOf(
  bytes: Uint8Array,
  opts: {
    readonly input?: string | undefined;
    readonly fuel?: number | undefined;
    readonly entry?: string | undefined;
  } = {},
): IsolationRequest<string> {
  return {
    asset: {
      kind: 'plugin',
      name: 'caps',
      version: '1',
      governance: { isolation: 'wasm' },
    } as never,
    payload: {
      kind: 'wasm-module',
      bytes,
      entry: opts.entry ?? 'process',
      fuel: opts.fuel ?? 1_000_000,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    },
    level: 'wasm',
  };
}

test('资源上限①：模块字节与入参超限 ⇒ 拒执行（且**不启动 worker**）', async () => {
  const runner = new BuiltinWasmRunner({ maxModuleBytes: 1024, maxInputBytes: 64 });
  const empty = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  const bigModule = new Uint8Array(2048);
  const moduleDenied = await runner.run(requestOf(bigModule));
  assert.strictEqual(moduleDenied.ok, false);
  assert.match((moduleDenied as { denied: { reason: string } }).denied.reason, /模块字节超限/);

  const inputDenied = await runner.run(requestOf(empty, { input: 'x'.repeat(200) }));
  assert.strictEqual(inputDenied.ok, false);
  assert.match((inputDenied as { denied: { reason: string } }).denied.reason, /入参超限/);
});

test('资源上限②：**无上限**线性内存声明 ⇒ 拒（把"能长多大"交给模块等于没有上限）', async () => {
  const runner = new BuiltinWasmRunner({ maxMemoryMb: 1 });
  // flags=0（无 max）+ min=1 ⇒ 可无限 grow ⇒ 必须拒。
  const unbounded = await runner.run(requestOf(moduleWithMemory([0x00, 0x01]), { entry: 'run' }));
  assert.strictEqual(unbounded.ok, false);
  assert.match((unbounded as { denied: { reason: string } }).denied.reason, /无上限.*线性内存/);

  // flags=1 + min=1 + max=1 ⇒ 有上限且 64 KiB ≤ 1 MiB ⇒ 放行（正例，证明上面的拒来自"无上限"）。
  const bounded = await runner.run(
    requestOf(moduleWithMemory([0x01, 0x01, 0x01]), { entry: 'run' }),
  );
  assert.strictEqual(bounded.ok, true, JSON.stringify(bounded));
});

test('资源上限③：声明内存**超过**配置上限 ⇒ 拒；等于上限则放行（边界值两侧都判）', async () => {
  const runner = new BuiltinWasmRunner({ maxMemoryMb: 1 }); // 1 MiB = 16 页
  // min=1、max=32 页（2 MiB）> 1 MiB ⇒ 拒。
  const tooBig = await runner.run(
    requestOf(moduleWithMemory([0x01, 0x01, 0x20]), { entry: 'run' }),
  );
  assert.strictEqual(tooBig.ok, false);
  assert.match((tooBig as { denied: { reason: string } }).denied.reason, /声明内存超限/);
  // min=1、max=16 页（恰好 1 MiB）⇒ 放行（边界值不误杀）。
  const atLimit = await runner.run(
    requestOf(moduleWithMemory([0x01, 0x01, 0x10]), { entry: 'run' }),
  );
  assert.strictEqual(atLimit.ok, true, JSON.stringify(atLimit));
});

test('资源上限④：返回值超限 / 越界 ⇒ 拒且**在读回之前**判定', async () => {
  const runner = new BuiltinWasmRunner({ maxOutputBytes: 128, maxMemoryMb: 1 });
  // **必须给入参**：只有 C-ABI 路径（`omni_alloc` → 入口(ptr,len) → 读回）才会去读模块声明的返回长度；
  // 无参调用只把 i64 转成字符串，压根没有"读回"这一步（夹具第一版就是这么绕过上限判定的）。
  const overCap = await runner.run(
    requestOf(moduleReturning(4096), { input: '{"method":"ping"}' }),
  );
  assert.strictEqual(overCap.ok, false, '超限的返回值不得被读回');
  assert.match((overCap as { denied: { reason: string } }).denied.reason, /返回值超限/);

  // 声称的长度落在内存之外（越界）⇒ 同样拒（不会读出一段垃圾当结果）。
  const outOfBounds = await runner.run(
    requestOf(moduleReturning(200_000), { input: '{"method":"ping"}' }),
  );
  assert.strictEqual(outOfBounds.ok, false);
  const reason = (outOfBounds as { denied: { reason: string } }).denied.reason;
  assert.ok(/返回值超限|返回值越界/.test(reason), `原因应可读，实际：${reason}`);
});

test('内存声明解析器：无内存段 / 有上限 / 无上限 / 多内存 / 截断 五类都给出确定结论', () => {
  // ① 无内存段（合法：纯计算模块）。
  const noMemory = WasmMemoryLimits.scan(
    Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
  assert.deepStrictEqual(noMemory, { ok: true, memories: [] });

  // ② 有上限：min=1 max=2。
  assert.deepStrictEqual(WasmMemoryLimits.scan(moduleWithMemory([0x01, 0x01, 0x02])), {
    ok: true,
    memories: [{ minPages: 1, maxPages: 2 }],
  });

  // ③ 无上限：只有 min。
  assert.deepStrictEqual(WasmMemoryLimits.scan(moduleWithMemory([0x00, 0x01])), {
    ok: true,
    memories: [{ minPages: 1, maxPages: undefined }],
  });

  // ④ 多内存（memory64/多内存扩展）：两条都读出来。
  assert.deepStrictEqual(
    WasmMemoryLimits.scan(
      Uint8Array.from([
        0x00,
        0x61,
        0x73,
        0x6d,
        0x01,
        0x00,
        0x00,
        0x00,
        ...section(5, [2, 0x01, 0x01, 0x02, 0x01, 0x03, 0x04]),
      ]),
    ),
    {
      ok: true,
      memories: [
        { minPages: 1, maxPages: 2 },
        { minPages: 3, maxPages: 4 },
      ],
    },
  );

  // ⑤ 截断：段长度越界 ⇒ 可读拒（不是静默当成"没有内存"）。
  const truncated = WasmMemoryLimits.scan(
    Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x40, 0x01]),
  );
  assert.strictEqual(truncated.ok, false);
  if (!truncated.ok) assert.match(truncated.reason, /长度越界|截断/);

  // 页大小是规范常量，判据依赖它（改了会静默改变所有内存口径）。
  assert.strictEqual(WASM_PAGE_BYTES, 65_536);
});

test('资源上限⑤：真实内核在**默认上限**下仍跑通（上限不是把功能卡死）', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const artifact = resolve(
    process.cwd(),
    'target',
    'wasm32-unknown-unknown',
    'release',
    'omni_wasm.wasm',
  );
  if (!existsSync(artifact)) {
    t.skip(
      '缺 wasm 产物，先执行：cargo build --release --target wasm32-unknown-unknown -p omni-wasm',
    );
    return;
  }
  const bytes = readFileSync(artifact);
  const scan = WasmMemoryLimits.scan(bytes);
  assert.strictEqual(scan.ok, true, scan.ok ? '' : scan.reason);
  // 内核必须**声明了内存上限**（否则它自己都过不了本档的门）。
  assert.ok(scan.memories.length > 0, '内核应有线性内存');
  for (const memory of scan.memories) {
    assert.notStrictEqual(
      memory.maxPages,
      undefined,
      '内核必须声明内存 max（可无限 grow 的模块本档拒执行）',
    );
  }
  const runner = new BuiltinWasmRunner({ timeoutMs: 10_000 });
  const result = await runner.run(
    requestOf(bytes, { input: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }),
  );
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(JSON.parse((result as { value: string }).value), { ok: true, pong: true });
});
