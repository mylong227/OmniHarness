/**
 * Wave C1（ADR-0010 · EVOLVIX_SPEC §6）：信任-隔离阶梯判据。
 *
 * 四档各自的**真实**承诺，逐条钉死：
 * 1. `in-process`：**逐位等价**（同一闭包在档内跑出的结果与直接调用完全一致）；
 * 2. `vm`：受限上下文（`require`/`process`/`module` 不可达）+ **同步死循环被 V8 vm timeout 真正中止**；
 * 3. `os-sandbox`：未注入原生执行器 ⇒ `level-unavailable` 拒（不假装有 OS 沙箱）；注入后走注入者；
 * 4. `wasm`：**未注入执行器 ⇒ 拒执行**（本仓内置实现见 `BuiltinWasmRunner`；J8 后该档可用），且**绝不静默降档**。
 *
 * 另四条纪律：
 * - 请求比资产声明更松 ⇒ `downgrade-not-allowed`（默认；显式 `allowDowngrade` 才放行）；
 * - 宿主闭包在更严档位 ⇒ `payload-unsupported`（跨 realm 会得到假隔离）；
 * - vm 载荷**必须自求值**（IIFE）——返回函数说明它没被执行，且跨 realm 调用不受 vm timeout 保护；
 * - wasm 载荷在非 wasm 档 ⇒ 同拒。
 *
 * 变异自证：把 `available('wasm')` 改成 true（或删掉可达性检查）⇒ wasm 用例立刻红——
 * 那正是「假装有 wasm 隔离」这种最危险的谎。同理删掉「返回函数即拒」⇒ 对应用例红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IsolationLadder } from '../../src/adapters/isolation/isolationLadder.js';
import type { CapabilityRecord } from '../../src/ports/capability.js';
import type { IsolationLevel } from '../../src/ports/capability.js';

/**
 * 造一条资产记录（档位可指定）。
 * @param isolation 声明的隔离档
 * @returns CapabilityRecord
 */
function assetAt(isolation: IsolationLevel): CapabilityRecord {
  return {
    asset: { name: 'probe' },
    schemaKind: 'skill',
    lineage: { parents: [], operator: 'test', bornAt: '2026-10-04T00:00:00.000Z' },
    fitness: undefined,
    governance: { trustTier: 'evolved', isolation, state: 'active', ledgerSeq: undefined },
  };
}

test('C1 in-process 档：逐位等价（同一闭包结果与直接调用完全一致）', async () => {
  const ladder = new IsolationLadder();
  const compute = (n: number): { readonly doubled: number; readonly tag: string } => ({
    doubled: n * 2,
    tag: 'ok',
  });
  const direct = compute(21);
  const result = await ladder.run({
    asset: assetAt('in-process'),
    payload: { kind: 'closure', run: () => compute(21) },
  });
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(result.value, direct, '档内结果必须与直接调用逐位一致');
    assert.strictEqual(result.level, 'in-process');
  }
  // 异步闭包同样支持。
  const asyncResult = await ladder.run({
    asset: assetAt('in-process'),
    payload: { kind: 'closure', run: async () => 'async-ok' },
  });
  assert.deepStrictEqual(asyncResult, { ok: true, value: 'async-ok', level: 'in-process' });
});

test('C1 vm 档：受限上下文（require/process/module 不可达）+ 自求值载荷回传结果', async () => {
  const ladder = new IsolationLadder();
  const result = await ladder.run<string>({
    asset: assetAt('vm'),
    payload: {
      kind: 'js-source',
      // 载荷**自求值**（IIFE）并把结果 JSON 化：跨 realm 的对象原型不同，
      // 用原始字符串搬运可避免「值看着一样但 deepStrictEqual 不相等」的假失败。
      code: '(() => JSON.stringify([typeof require, typeof process, typeof module, 6 * 7].map(String)))()',
      filename: 'probe.js',
    },
  });
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.deepStrictEqual(
      JSON.parse(result.value),
      ['undefined', 'undefined', 'undefined', '42'],
      'vm 档内不得触达宿主能力，且表达式值原样回传',
    );
  }
});

test('C1 vm 档：同步死循环被 vm timeout 真正中止（超时 ⇒ 拒执行，reason 可读）', async () => {
  const ladder = new IsolationLadder();
  const result = await ladder.run({
    asset: assetAt('vm'),
    payload: { kind: 'js-source', code: '(() => { while (true) {} })()', filename: 'spin.js' },
    timeoutMs: 50,
  });
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.denied.code, 'timeout');
    assert.strictEqual(result.denied.level, 'vm');
    assert.match(result.denied.reason, /超时|timed out/);
  }
});

test('C1 vm 档：触达宿主能力（require）⇒ escape 拒执行', async () => {
  const ladder = new IsolationLadder();
  const result = await ladder.run({
    asset: assetAt('vm'),
    payload: { kind: 'js-source', code: '(() => require("node:fs"))()', filename: 'escape.js' },
  });
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.denied.code, 'escape');
    assert.match(result.denied.reason, /触达宿主能力/);
  }
});

test('C1 vm 档：载荷未自求值（返回函数）⇒ 拒（跨 realm 调用不受 vm timeout 保护）', async () => {
  const ladder = new IsolationLadder();
  const result = await ladder.run({
    asset: assetAt('vm'),
    payload: { kind: 'js-source', code: '() => "never-run"', filename: 'lazy.js' },
  });
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.denied.code, 'payload-unsupported');
    assert.match(result.denied.reason, /必须自求值/);
    assert.match(result.denied.reason, /不受 vm timeout 保护/);
  }
});

test('C1 wasm 档不可达 ⇒ 拒绝执行（绝不静默降档；判据对「假装有 wasm」变红）', async () => {
  const ladder = new IsolationLadder();
  // J8 落地后 wasm 档**可注入**（内置 BuiltinWasmRunner）；本判据点仍是「绝不假装有档位」，
  // 只是「不可达」的成因从「本仓没有运行时」变成「本处没注入执行器」。
  assert.strictEqual(ladder.available('wasm'), false, '未注入执行器 ⇒ wasm 档必须如实申报不可达');
  assert.strictEqual(
    ladder.available('os-sandbox'),
    false,
    '未注入原生执行器 ⇒ os-sandbox 亦不可达',
  );
  assert.strictEqual(ladder.available('in-process'), true);
  assert.strictEqual(ladder.available('vm'), true);

  const result = await ladder.run({
    asset: assetAt('wasm'),
    payload: { kind: 'wasm-module', bytes: new Uint8Array([0, 97, 115, 109]), fuel: 1000 },
  });
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.denied.code, 'level-unavailable');
    assert.match(result.denied.reason, /未注入 wasm 执行器/);
    assert.match(result.denied.reason, /不静默降档/);
  }
});

test('C1 os-sandbox 档：注入原生执行器即可达并走注入者；未注入即拒', async () => {
  const calls: string[] = [];
  const withRunner = new IsolationLadder({
    osRunner: async (request) => {
      calls.push(request.asset.schemaKind);
      return 'ran-in-os';
    },
  });
  assert.strictEqual(withRunner.available('os-sandbox'), true);
  const result = await withRunner.run<string>({
    asset: assetAt('os-sandbox'),
    payload: { kind: 'js-source', code: '(() => "x")()', filename: 'x.js' },
  });
  assert.deepStrictEqual(result, { ok: true, value: 'ran-in-os', level: 'os-sandbox' });
  assert.deepStrictEqual(calls, ['skill'], '必须真的经注入的执行器');

  const failing = new IsolationLadder({
    osRunner: () => Promise.reject(new Error('沙箱启动失败')),
  });
  const failed = await failing.run({
    asset: assetAt('os-sandbox'),
    payload: { kind: 'js-source', code: '(() => "x")()', filename: 'x.js' },
  });
  assert.strictEqual(failed.ok, false);
  if (!failed.ok) {
    assert.strictEqual(failed.denied.code, 'trap');
    assert.match(failed.denied.reason, /沙箱启动失败/);
  }

  const withoutRunner = new IsolationLadder();
  const denied = await withoutRunner.run({
    asset: assetAt('os-sandbox'),
    payload: { kind: 'js-source', code: '(() => "x")()', filename: 'x.js' },
  });
  assert.strictEqual(denied.ok, false);
  if (!denied.ok) assert.strictEqual(denied.denied.code, 'level-unavailable');
});

test('C1 只可收紧：请求比资产声明更松 ⇒ downgrade-not-allowed（显式 allowDowngrade 才放行）', async () => {
  const strict = new IsolationLadder();
  const denied = await strict.run({
    asset: assetAt('vm'),
    payload: { kind: 'closure', run: () => 'x' },
    level: 'in-process',
  });
  assert.strictEqual(denied.ok, false);
  if (!denied.ok) {
    assert.strictEqual(denied.denied.code, 'downgrade-not-allowed');
    assert.match(denied.denied.reason, /资产声明 vm，请求 in-process/);
  }

  const relaxed = new IsolationLadder({ allowDowngrade: true });
  const allowed = await relaxed.run({
    asset: assetAt('vm'),
    payload: { kind: 'closure', run: () => 'x' },
    level: 'in-process',
  });
  assert.deepStrictEqual(allowed, { ok: true, value: 'x', level: 'in-process' });

  // 收紧永远是允许的（in-process 资产请求 vm 档，载荷换成源码）。
  const tightened = await strict.run<string>({
    asset: assetAt('in-process'),
    payload: { kind: 'js-source', code: '(() => "tightened")()', filename: 't.js' },
    level: 'vm',
  });
  assert.deepStrictEqual(tightened, { ok: true, value: 'tightened', level: 'vm' });
});

test('C1 载荷与档位匹配：宿主闭包在更严档位 ⇒ payload-unsupported（不假装隔离）', async () => {
  const ladder = new IsolationLadder();
  const result = await ladder.run({
    asset: assetAt('vm'),
    payload: { kind: 'closure', run: () => 'x' },
    level: 'vm',
  });
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.denied.code, 'payload-unsupported');
    assert.match(result.denied.reason, /跨 realm 会得到假隔离/);
  }

  const wasmOnVm = await ladder.run({
    asset: assetAt('vm'),
    payload: { kind: 'wasm-module', bytes: new Uint8Array([0, 97, 115, 109]) },
  });
  assert.strictEqual(wasmOnVm.ok, false);
  if (!wasmOnVm.ok) assert.strictEqual(wasmOnVm.denied.code, 'payload-unsupported');
});
