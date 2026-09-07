// 端到端验证 omni-wasm wasm 插件边界：TS 侧通过 WebAssembly 调用 Rust 内核。
// 默认加载 release 优化产物（约 77KB，4.1MB debug 的 ~2%）；可用 OMNIHARNESS_WASM=debug 切到 debug。
import { readFileSync } from 'node:fs';
import { env as processEnv } from 'node:process';
const profile = processEnv.OMNIHARNESS_WASM ?? 'release';
const wasmPath = `target/wasm32-unknown-unknown/${profile}/omni_wasm.wasm`;
console.log(`[wasmE2e] 加载 wasm 产物: ${wasmPath}`);
const wasmBytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const { memory, omni_init, omni_alloc, process, omni_dealloc } = instance.exports;

// 初始化内核（注册 echo 工具）。
omni_init();

// 编码字符串到 wasm 内存，返回 { ptr, len }。
function writeStr(s) {
  const bytes = new TextEncoder().encode(s);
  const ptr = omni_alloc(bytes.length);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

// 从 wasm 内存读取字符串（ptr, len）。
function readStr(ptr, len) {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

// 解包 process 返回的 (ptr, len) i64。
function unpack(combined) {
  const len = Number(BigInt.asUintN(64, BigInt(combined)) >> 32n);
  const ptr = Number(BigInt.asUintN(32, BigInt(combined)));
  return { ptr, len };
}

// 发起一次 JSON-RPC 请求。
function rpc(method, params) {
  const { ptr, len } = writeStr(JSON.stringify({ method, params }));
  const resp = process(ptr, len);
  const { ptr: rptr, len: rlen } = unpack(resp);
  const json = readStr(rptr, rlen);
  omni_dealloc(rptr, rlen);
  return JSON.parse(json);
}

// 测试用例。
console.log('=== 1. ping ===');
console.log(JSON.stringify(rpc('ping', {})));

console.log('=== 2. tool_call echo（Rust 内核执行工具）===');
const r2 = rpc('tool_call', { name: 'echo', args: { text: 'wasm 边界打通' } });
console.log(JSON.stringify(r2));
console.log('事件条数:', r2.events.length);

console.log('=== 3. 未知工具 fail-closed ===');
console.log(JSON.stringify(rpc('tool_call', { name: 'nope', args: {} })));

console.log('=== 4. 非法 JSON ===');
console.log(JSON.stringify(rpc('not json', {})));

console.log('=== 5. tools.list（内核工具元数据自省）===');
const r5 = rpc('tools.list', {});
console.log(JSON.stringify(r5));
console.log('工具数量:', r5.tools?.length);

console.log('=== 6. math.eval（内置工具经内核执行）===');
const r6 = rpc('tool_call', { name: 'math.eval', args: { expression: '(1+2)*3' } });
console.log(JSON.stringify(r6));

console.log('=== 7. tools.list 数量（应含 fs.list_dir）===');
console.log('工具数量:', r5.tools?.length, '名称:', r5.tools?.map((t) => t.name).join(','));

console.log('=== 8. math.eval 一元负号（-(1+2)）===');
const r8 = rpc('tool_call', { name: 'math.eval', args: { expression: '-(1+2)+5' } });
console.log(JSON.stringify(r8));

console.log('=== 9. session.submit（SQ/EQ 状态机：用户输入开合回合）===');
const r9 = rpc('session.submit', { submission: { kind: 'userInput', text: '你好 wasm' } });
console.log(JSON.stringify(r9));

console.log('=== 10. session.submit（工具调用走审批→沙箱→执行链）===');
const r10 = rpc('session.submit', {
  submission: { kind: 'toolCall', callId: 'c1', name: 'math.eval', args: { expression: '6*7' } },
});
console.log(JSON.stringify(r10));

console.log('=== 11. session.submit（危险命令被沙箱拦截）===');
const r11 = rpc('session.submit', {
  submission: { kind: 'toolCall', callId: 'c2', name: 'shell', args: { command: 'rm -rf /tmp' } },
});
console.log(JSON.stringify(r11));

console.log('=== 12. context.render（碎片 + 历史 + token 估算）===');
const r12 = rpc('context.render', {});
console.log(JSON.stringify({ ok: r12.ok, tokens: r12.tokens, sample: r12.context?.slice(0, 60) }));

console.log('=== 13. approval.check（审批裁决三态）===');
const r13 = rpc('approval.check', { name: 'shell', args: { command: 'git push origin main' } });
console.log(JSON.stringify(r13));

// 自动断言（强验收）。
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`[PASS] ${msg}`);
  }
};
assert(r6.ok === true && r6.output === '9', 'math.eval (1+2)*3 = 9');
assert(r8.ok === true && r8.output === '2', 'math.eval -(1+2)+5 = 2');
assert(r5.ok === true && r5.tools.length === 6, 'tools.list 返回 6 个工具');
assert(
  r5.tools.some((t) => t.name === 'fs.list_dir'),
  'tools.list 含 fs.list_dir',
);
assert(r5.tools.find((t) => t.name === 'fs.list_dir').description.length > 0, 'fs.list_dir 有描述');
assert(
  r9.ok === true &&
    r9.ops.some((o) => o.kind === 'turnStarted') &&
    r9.ops.some((o) => o.kind === 'turnCompleted'),
  'session.submit 用户输入产生 turnStarted/turnCompleted',
);
assert(
  r10.ok === true &&
    r10.ops.some((o) => o.kind === 'toolResult' && o.ok === true && o.output === '42'),
  'session.submit 工具调用经执行链产出 42',
);
assert(
  r11.ok === true &&
    r11.ops.some((o) => o.kind === 'toolResult' && o.ok === false && o.output.includes('危险命令')),
  'session.submit 危险命令被沙箱拦截',
);
assert(
  r12.ok === true && r12.tokens > 0 && r12.context.includes('math.eval'),
  'context.render 含历史与 token 估算',
);
assert(
  r13.ok === true && r13.decision?.decision === 'allow',
  'approval.check 输出裁决（标准配置默认放行）',
);

console.log('ALL OK');
