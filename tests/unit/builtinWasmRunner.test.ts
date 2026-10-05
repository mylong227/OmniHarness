/**
 * **J8** 判据：`wasm` 档内**越界访问 / 超 fuel ⇒ 拒执行且 reason 可读**（变异：关 fuel metering ⇒ 红）。
 *
 * ## 判据逐条对应（`EVOLVIX_SPEC_2026-10.md` §8 J8）
 *
 * | # | 判据原文 | 本文件怎么判 |
 * | --- | --- | --- |
 * | ① | 正例（能跑的模块必须跑通，否则"全拒"也能骗过安全判据） | `() -> i32 = 42` ⇒ `ok:true`、值 `42`、`level:'wasm'` |
 * | ② | **越界访问 ⇒ 拒执行且 reason 可读** | 声明 1 页内存、从地址 100 读 8 字节（越界）⇒ `denied.code==='trap'` 且 reason 含越界信息 |
 * | ③ | **超 fuel ⇒ 拒执行且 reason 可读** | 死循环模块 + 时间预算 ⇒ `denied.code==='timeout'`、reason 点名预算值，**且必须真的返回**（证明确实被中止） |
 * | ④ | **变异方向：关 fuel metering ⇒ 红** | 不给预算（`fuel` 缺省 / `0`）⇒ **直接拒执行**（`payload-unsupported`）：本档**不做无预算执行**，所以"关掉计量"不可能静默变成"放它跑" |
 * | ⑤ | 宿主能力面 | 模块声明任何 import ⇒ 拒，reason **点名** import（默认拒绝全部宿主能力） |
 * | ⑥ | 空/畸形输入 | 空字节 / 非 wasm 字节 ⇒ 拒且原因可读（不是"跑了个空模块"） |
 *
 * ## 夹具：手工构造 wasm 字节（**零依赖、无 cargo、无网络**）
 *
 * 每个模块都是几十字节的合法 wasm 二进制，注释里给出分段结构。选它而不是 `cargo build
 * --target wasm32-unknown-unknown`：判据要**快且确定性**（CI 里不该为一次断言编译 Rust）；
 * 真实 crate 的端到端编译留给集成演练，不在本文件里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BuiltinWasmRunner } from '../../src/adapters/isolation/builtinWasmRunner.js';
import { IsolationLadder } from '../../src/adapters/isolation/isolationLadder.js';
import type { IsolationRequest } from '../../src/ports/runtime/isolation.js';

/**
 * 组装一个 wasm 模块。
 * @param sections 各段字节（不含魔数/版本）
 * @returns 模块字节
 */
function wasmModule(...sections: readonly number[][]): Uint8Array {
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

/**
 * 造一个段（`id` + 长度前缀 + 内容）。
 * @param id 段 id
 * @param payload 段内容
 * @returns 段字节
 */
function section(id: number, payload: readonly number[]): number[] {
  return [id, payload.length, ...payload];
}

/**
 * 造一个名字（`len` + UTF-8）。
 * @param text 名字
 * @returns 字节
 */
function name(text: string): number[] {
  const bytes = Buffer.from(text, 'utf8');
  return [bytes.length, ...bytes];
}

/**
 * 造"类型段 + 函数段 + 导出段 + 代码段"四件套（单函数模块）。
 * @param exportName 导出名
 * @param typeSection 类型向量元素
 * @param body 函数体（**含**长度前缀前的 locals + 指令 + end）
 * @param opts 额外段（如内存段，插在**函数段之后**——wasm 段序有硬约束：
 *   type(1) → import(2) → func(3) → table(4) → memory(5) → global(6) → export(7) → code(10)）
 * @returns 模块字节
 */
function singleFunctionModule(
  exportName: string,
  typeSection: readonly number[],
  body: readonly number[],
  opts: { readonly extraSections?: readonly number[][][] | undefined } = {},
): Uint8Array {
  const bodyBytes = [body.length, ...body];
  const extra = (opts.extraSections ?? []).flat();
  return wasmModule(
    section(1, [1, ...typeSection]),
    section(3, [1, 0x00]),
    ...extra,
    section(7, [1, ...name(exportName), 0x00, 0x00]),
    section(10, [1, ...bodyBytes]),
  );
}

/** 取结果里的拒因（断言用；调用方保证已失败）。 */
function denialOf(result: { readonly ok: boolean }): {
  readonly code: string;
  readonly reason: string;
} {
  assert.strictEqual(result.ok, false, '本用例期望被拒');
  return (result as unknown as { denied: { code: string; reason: string } }).denied;
}

/**
 * 造一个 wasm 隔离请求。
 * @param bytes 模块字节
 * @param opts fuel / timeoutMs / entry
 * @returns 请求
 */
function requestOf(
  bytes: Uint8Array,
  opts: {
    readonly fuel?: number | undefined;
    readonly timeoutMs?: number | undefined;
    readonly entry?: string;
  } = {},
): IsolationRequest<string> {
  return {
    asset: { kind: 'plugin', name: 'j8-asset', version: '1' } as never,
    payload: {
      kind: 'wasm-module',
      bytes,
      ...(opts.fuel !== undefined ? { fuel: opts.fuel } : {}),
      ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

test('J8 ①正例：能跑的模块必须跑通（防"一律拒绝"骗过安全判据）', async () => {
  // (func (export "answer") (result i32) i32.const 42)：locals=0, i32.const 42, end
  const bytes = singleFunctionModule('answer', [0x60, 0x00, 0x01, 0x7f], [0x00, 0x41, 0x2a, 0x0b]);
  const result = await new BuiltinWasmRunner().run(requestOf(bytes, { fuel: 1000 }));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual((result as { value: string }).value, '42');
  assert.strictEqual((result as { level: string }).level, 'wasm');
});

test('J8 ②越界访问：拒执行且 reason 可读（越界信息原样透出）', async () => {
  // 内存 1 页（min=1）；函数 i32.load offset=100 读 4 字节 ⇒ 越界（1 页=65536 字节，100 合法…）
  // 故用**极大偏移**确保越界：i32.const 65535; i32.load align=2 offset=0 ⇒ 65535+4 > 65536。
  const bytes = singleFunctionModule(
    'oob',
    [0x60, 0x00, 0x01, 0x7f],
    [0x00, 0x41, 0xff, 0xff, 0x03, 0x28, 0x02, 0x00, 0x0b],
    { extraSections: [[section(5, [1, 0x00, 0x01])]] },
  );
  const result = await new BuiltinWasmRunner().run(requestOf(bytes, { fuel: 1000 }));
  const denied = denialOf(result);
  assert.strictEqual(denied.code, 'trap');
  assert.match(denied.reason, /out of bounds|越界/i, `reason 必须可读：${denied.reason}`);
});

test('J8 ③超 fuel：拒执行且 reason 点名预算，**且必须真的被中止**（不挂死）', async () => {
  // (func (export "spin") (loop br 0))
  const bytes = singleFunctionModule(
    'spin',
    [0x60, 0x00, 0x00],
    [0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b],
  );
  const started = Date.now();
  const result = await new BuiltinWasmRunner().run(
    requestOf(bytes, { fuel: 1_000_000, timeoutMs: 300 }),
  );
  const elapsed = Date.now() - started;
  const denied = denialOf(result);
  assert.strictEqual(denied.code, 'timeout');
  assert.match(denied.reason, /超出执行预算/, 'reason 必须说清是预算超限');
  assert.match(denied.reason, /300ms/, 'reason 必须点名预算值');
  assert.match(denied.reason, /已强制终止/);
  // **真中止**：返回时刻必须接近预算而不是等到循环自己结束（它永远不会结束）。
  assert.ok(elapsed < 3000, `必须被及时中止，实际 ${String(elapsed)}ms`);
});

test('J8 ④变异：关 fuel metering（无预算）⇒ **直接拒执行**（红），绝不静默放它跑', async () => {
  const bytes = singleFunctionModule(
    'spin',
    [0x60, 0x00, 0x00],
    [0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b],
  );
  for (const fuel of [undefined, 0, -1]) {
    const started = Date.now();
    const result = await new BuiltinWasmRunner().run(requestOf(bytes, { fuel, timeoutMs: 300 }));
    const denied = denialOf(result);
    assert.strictEqual(denied.code, 'payload-unsupported', `fuel=${String(fuel)} 必须直接拒`);
    assert.match(denied.reason, /未声明执行预算/, 'reason 必须点名"无预算不执行"');
    assert.ok(Date.now() - started < 200, '无预算必须**立即**拒（不得先跑再拒）');
  }
});

test('J8 ⑤宿主能力面：模块声明任何 import ⇒ 拒，且 reason 点名 import', async () => {
  // 导入段：1 个导入，module="env" name="host"，kind=func type=0。
  const importSection = section(2, [1, ...name('env'), ...name('host'), 0x00, 0x00]);
  const bytes = wasmModule(
    section(1, [1, 0x60, 0x00, 0x00]),
    importSection,
    section(3, [1, 0x00]),
    section(7, [1, ...name('run'), 0x00, 0x01]),
    section(10, [1, 0x02, 0x00, 0x0b]),
  );
  const result = await new BuiltinWasmRunner().run(requestOf(bytes, { fuel: 1000 }));
  const denied = denialOf(result);
  assert.strictEqual(denied.code, 'payload-unsupported');
  assert.match(denied.reason, /env\.host/, 'reason 必须点名具体 import');
});

test('J8 ⑥空/畸形输入：拒且原因可读（不是"跑了个空模块"）', async () => {
  const runner = new BuiltinWasmRunner();
  const empty = await runner.run(requestOf(new Uint8Array(), { fuel: 1000 }));
  assert.match(denialOf(empty).reason, /字节为空/);
  const garbage = await runner.run(requestOf(Uint8Array.from([1, 2, 3, 4]), { fuel: 1000 }));
  const garbageDenied = denialOf(garbage);
  assert.strictEqual(
    garbageDenied.code,
    'trap',
    '非 wasm 字节必须被判为 trap（编译失败），不是"跑通了"',
  );
  assert.ok(garbageDenied.reason.length > 0, 'reason 必须非空');
  // 非 wasm 载荷也拒（档位只接受 wasm-module）。
  const wrongKind = await runner.run({
    asset: { kind: 'plugin', name: 'x', version: '1' } as never,
    payload: { kind: 'js-source', code: '1+1' },
  } as IsolationRequest<string>);
  assert.match(denialOf(wrongKind).reason, /只接受 wasm-module/);
});

test('J8 阶梯集成：未注入执行器 ⇒ wasm 档仍 fail-closed；注入后越界同样被拒', async () => {
  const bytes = singleFunctionModule(
    'oob',
    [0x60, 0x00, 0x01, 0x7f],
    [0x00, 0x41, 0xff, 0xff, 0x03, 0x28, 0x02, 0x00, 0x0b],
    { extraSections: [[section(5, [1, 0x00, 0x01])]] },
  );
  const request = {
    asset: {
      kind: 'plugin',
      name: 'evolved-asset',
      version: '1',
      governance: { isolation: 'wasm' },
    } as never,
    payload: { kind: 'wasm-module', bytes, fuel: 1000 },
    level: 'wasm',
  } as IsolationRequest<string>;

  // 未注入：档位不可达 ⇒ 拒（不静默降档）。
  const withoutRunner = await new IsolationLadder().run(request);
  assert.strictEqual(withoutRunner.ok, false);
  assert.strictEqual(
    (withoutRunner as { denied: { code: string } }).denied.code,
    'level-unavailable',
  );

  // 注入后：可达，且越界仍被拒（隔离保证不因"接上了执行器"而放松）。
  const ladder = new IsolationLadder({ wasmRunner: (r) => new BuiltinWasmRunner().run(r) });
  assert.strictEqual(ladder.available('wasm'), true);
  const withRunner = await ladder.run(request);
  assert.strictEqual(withRunner.ok, false);
  assert.strictEqual((withRunner as { denied: { code: string } }).denied.code, 'trap');

  // 正例同时经阶梯跑通（证明上面的"拒"来自越界，而不是档位整体不可用）。
  const good = singleFunctionModule('answer', [0x60, 0x00, 0x01, 0x7f], [0x00, 0x41, 0x2a, 0x0b]);
  const okResult = await ladder.run({
    ...request,
    payload: { kind: 'wasm-module', bytes: good, fuel: 1000 },
  } as IsolationRequest<string>);
  assert.strictEqual(okResult.ok, true, JSON.stringify(okResult));
  assert.strictEqual((okResult as { value: string }).value, '42');
});

test('J8 生产装配：工厂产出的阶梯 wasm 档可达，且越界/超预算仍被拒（接线不放松隔离）', async () => {
  const { IsolationLadderFactory } =
    await import('../../src/adapters/isolation/isolationLadderFactory.js');
  const ladder = IsolationLadderFactory.builtin();
  // ① 可达：漏注入是"声明了 wasm 的包被静默拒装"的根因，症状与真实越界极像，故必须显式断言。
  assert.strictEqual(ladder.available('wasm'), true);
  // ② 未注入的档位仍然 fail-closed（不因工厂顺手把 os-sandbox 也假装打开）。
  assert.strictEqual(ladder.available('os-sandbox'), false);

  const asset = {
    kind: 'plugin',
    name: 'evolved-wasm-asset',
    version: '1',
    governance: { isolation: 'wasm' },
  } as never;
  // ③ 越界经工厂路径同样被拒（接线不改变执法强度）。
  const oob = singleFunctionModule(
    'oob',
    [0x60, 0x00, 0x01, 0x7f],
    [0x00, 0x41, 0xff, 0xff, 0x03, 0x28, 0x02, 0x00, 0x0b],
    { extraSections: [[section(5, [1, 0x00, 0x01])]] },
  );
  const denied = await ladder.run({
    asset,
    payload: { kind: 'wasm-module', bytes: oob, fuel: 1000 },
    level: 'wasm',
  } as IsolationRequest<string>);
  assert.strictEqual(denied.ok, false);
  assert.strictEqual((denied as { denied: { code: string } }).denied.code, 'trap');

  // ④ 无预算同样直接拒（"关 fuel metering ⇒ 红"经工厂路径依然成立）。
  const spin = singleFunctionModule(
    'spin',
    [0x60, 0x00, 0x00],
    [0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b],
  );
  const noBudget = await ladder.run({
    asset,
    payload: { kind: 'wasm-module', bytes: spin },
    level: 'wasm',
  } as IsolationRequest<string>);
  assert.strictEqual((noBudget as { denied: { code: string } }).denied.code, 'payload-unsupported');
});
