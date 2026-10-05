/**
 * **Wave C / J8 端到端**：把 `crates/omni-wasm` 编译出的**真实 wasm 内核**跑在 `wasm` 隔离档上。
 *
 * ## 这条判据补的是什么
 *
 * `builtinWasmRunner.test.ts` 用手工 wasm 字节证明"隔离语义"（越界 / 预算 / import / 无预算）；
 * 本文件证明"**本仓真产物能用**"——206 KB 的 `omni_wasm.wasm` 走 C-ABI 宿主协议在 wasm 档应答
 * JSON-RPC（`ping` / `tools.list` / `tool_call`），且**同一套强制仍然生效**（无预算即拒）。
 * 两者缺一不可：只测手工字节 ⇒ 可能"隔离很严但啥也跑不了"；只测真产物 ⇒ 可能"能跑但档位是假的"。
 *
 * ## 产物缺失时**跳过而不是造假**
 *
 * `target/wasm32-unknown-unknown/release/omni_wasm.wasm` 由 cargo 产出（本仓不把它提交进版本库）。
 * 缺产物即 `t.skip` 并打印**可执行的**构建命令——绝不用"手工字节"冒充真产物让判据变绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BuiltinWasmRunner } from '../../src/adapters/isolation/builtinWasmRunner.js';
import { IsolationLadderFactory } from '../../src/adapters/isolation/isolationLadderFactory.js';
import type { IsolationRequest } from '../../src/ports/runtime/isolation.js';

/**
 * 最小 `WebAssembly` 类型面（主 tsconfig 的 `lib` 只有 ES2024，@types/node 也不声明它；
 * 为一个判据给整个项目引入 DOM 全局不划算——与 worker 侧同一理由）。
 */
interface WasmModuleCtorFace {
  new (bytes: Uint8Array): object;
  imports(module: object): readonly { readonly module: string; readonly name: string }[];
  exports(module: object): readonly { readonly name: string; readonly kind: string }[];
}

/** 取 `WebAssembly` 全局（缺失即测试环境异常，直接抛比静默跳过好）。 */
const wasmApi = (
  globalThis as unknown as { readonly WebAssembly: { readonly Module: WasmModuleCtorFace } }
).WebAssembly;

/** 产物路径（本仓 Rust 工作区标准输出位置）。 */
const ARTIFACT = resolve(
  process.cwd(),
  'target',
  'wasm32-unknown-unknown',
  'release',
  'omni_wasm.wasm',
);

/** 构建命令（判据跳过时打印，保证"可执行"）。 */
const BUILD_CMD = 'cargo build --release --target wasm32-unknown-unknown -p omni-wasm';

/**
 * 读产物字节；缺失时返回 undefined（调用方 skip 并打印构建命令）。
 * @returns 模块字节或 undefined
 */
function loadArtifact(): Uint8Array | undefined {
  return existsSync(ARTIFACT) ? readFileSync(ARTIFACT) : undefined;
}

/**
 * 造一条 wasm 资产记录（`governance.isolation: 'wasm'` = 该资产要求 wasm 档）。
 * @returns 资产记录
 */
function wasmAsset(): unknown {
  return {
    kind: 'plugin',
    name: 'omni-wasm-kernel',
    version: '0.1.0',
    governance: { isolation: 'wasm' },
  };
}

/**
 * 造一条 C-ABI 请求。
 * @param bytes 模块字节
 * @param rpcRequest JSON-RPC 请求对象
 * @param opts fuel / timeoutMs
 * @returns 隔离请求
 */
function requestOf(
  bytes: Uint8Array,
  rpcRequest: Record<string, unknown>,
  opts: { readonly fuel?: number | undefined; readonly timeoutMs?: number | undefined } = {},
): IsolationRequest<string> {
  return {
    asset: wasmAsset() as never,
    payload: {
      kind: 'wasm-module',
      bytes,
      entry: 'process',
      input: JSON.stringify(rpcRequest),
      ...(opts.fuel !== undefined ? { fuel: opts.fuel } : { fuel: 1_000_000 }),
    },
    level: 'wasm',
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

test('Wave C E2E：真 wasm 内核（omni_wasm.wasm）在 wasm 档应答 JSON-RPC，且零 import', async (t) => {
  const bytes = loadArtifact();
  if (bytes === undefined) {
    t.skip(`缺 wasm 产物，先执行：${BUILD_CMD}`);
    return;
  }
  // ① 零 import：这是"默认拒绝全部 import"能同时跑真内核的前提，故显式断言（不是默认假设）。
  const module = new wasmApi.Module(bytes);
  assert.deepStrictEqual(wasmApi.Module.imports(module), [], '内核不得依赖任何宿主 import');
  const exports = wasmApi.Module.exports(module).map((entry) => entry.name);
  for (const required of ['memory', 'omni_alloc', 'omni_dealloc', 'process']) {
    assert.ok(
      exports.includes(required),
      `内核必须导出 ${required}（C-ABI 协议），实际：${exports.join(', ')}`,
    );
  }

  // ② ping：最小闭环（证明宿主写内存 → 调用 → 读回 → 释放整条链路可用）。
  const ladder = IsolationLadderFactory.builtin({ timeoutMs: 10_000 });
  const ping = await ladder.run(requestOf(bytes, { jsonrpc: '2.0', id: 1, method: 'ping' }));
  assert.strictEqual(ping.ok, true, JSON.stringify(ping));
  assert.deepStrictEqual(JSON.parse((ping as { value: string }).value), { ok: true, pong: true });

  // ③ tools.list：真内核的**状态**（Rust 侧注册的内置工具集）经 wasm 边界回传。
  const tools = await ladder.run(requestOf(bytes, { jsonrpc: '2.0', id: 2, method: 'tools.list' }));
  assert.strictEqual(tools.ok, true, JSON.stringify(tools));
  const parsed = JSON.parse((tools as { value: string }).value) as {
    ok: boolean;
    tools: readonly { name: string }[];
  };
  assert.strictEqual(parsed.ok, true);
  assert.ok(parsed.tools.length > 0, '内核必须注册了内置工具');
  // 工具名是**命名空间化**的（`fs.read_file` 等）——判据第一版按裸名断言，读到了真名单才发现。
  assert.ok(
    parsed.tools.some((tool) => tool.name.endsWith('read_file')),
    `内置工具集应含读文件工具，实际：${parsed.tools.map((tool) => tool.name).join(', ')}`,
  );

  // ④ tool_call（纯计算）：经 wasm 边界真跑一次工具，回传「调用 + 结果」两个事件。
  const call = await ladder.run(
    requestOf(bytes, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tool_call',
      params: { name: 'echo', args: { text: 'hi' }, callId: 'c-1' },
    }),
  );
  assert.strictEqual(call.ok, true, JSON.stringify(call));
  const callResult = JSON.parse((call as { value: string }).value) as {
    ok: boolean;
    events: readonly { readonly type: string }[];
  };
  assert.strictEqual(callResult.ok, true, 'echo 是纯计算工具，必须成功');
  // 事件结构：`{ id, payload:{args,callId,name}, session_id, timestamp, type }`——`type` 在**顶层**
  // （判据第一版按 `payload.type` 取，读到的是 undefined；字段路径也是"必须按真实结构断言"的一部分）。
  assert.deepStrictEqual(
    callResult.events.map((event) => event.type),
    ['tool_call', 'tool_result'],
    '应回传「调用 + 结果」两个事件',
  );

  // ⑤ **这条边界必须写进判据**：wasm 档默认拒绝全部 import ⇒ **没有文件系统**（WASI 未接），
  // 因此文件类工具在该档**必然失败**。要求的是"如实回报"，不是"假装能读"。
  const fsCall = await ladder.run(
    requestOf(bytes, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tool_call',
      params: { name: 'fs.read_file', args: { path: 'package.json' }, callId: 'c-2' },
    }),
  );
  assert.strictEqual(fsCall.ok, true, 'JSON-RPC 本身应成功（失败发生在工具层）');
  const fsResult = JSON.parse((fsCall as { value: string }).value) as {
    ok: boolean;
    output: string;
  };
  assert.strictEqual(fsResult.ok, false, 'wasm 档无文件系统 ⇒ 文件工具不得"成功"');
  assert.ok(fsResult.output.length > 0, '失败必须带可读原因（不是空字符串）');
});

test('Wave C E2E：真产物同样受预算强制（无预算即拒 / 极小预算 ⇒ 超时拒）', async (t) => {
  const bytes = loadArtifact();
  if (bytes === undefined) {
    t.skip(`缺 wasm 产物，先执行：${BUILD_CMD}`);
    return;
  }
  const runner = new BuiltinWasmRunner({ timeoutMs: 5000 });
  // ① 无预算 ⇒ 直接拒（"关 fuel metering ⇒ 红"对真产物同样成立）。
  const noBudget = await runner.run({
    asset: wasmAsset() as never,
    payload: {
      kind: 'wasm-module',
      bytes,
      entry: 'process',
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    },
    level: 'wasm',
  } as IsolationRequest<string>);
  assert.strictEqual(noBudget.ok, false);
  assert.match(
    (noBudget as { denied: { reason: string } }).denied.reason,
    /未声明执行预算/,
    '真产物也不得在无预算下执行',
  );

  // ② 极小预算：要么在预算内完成（可能，内核很快），要么被强制终止；**不得**无界运行。
  const started = Date.now();
  const tiny = await runner.run(
    requestOf(bytes, { jsonrpc: '2.0', id: 2, method: 'tools.list' }, { timeoutMs: 1 }),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `必须在预算量级内返回，实际 ${String(elapsed)}ms`);
  if (!tiny.ok) {
    assert.strictEqual(
      (tiny as { denied: { code: string } }).denied.code,
      'timeout',
      '极小预算下的失败必须是 timeout（而不是 trap/其它）',
    );
  }
});
