// #65 E2E：验证 omni_napi.node 的完整 JSON-RPC 面（native 内核）。
'use strict';
const path = require('node:path');
const fs = require('node:fs');

// OS 沙箱包装后的命令为 `omni-cli sandbox run ...`，需把 target 目录加进 PATH
//（wrap 语义与 bwrap/seatbelt 一致：要求 omni-cli 可解析）。
const root = path.join(__dirname, '..');
const targetDirs = [path.join(root, 'target', 'debug'), path.join(root, 'target', 'release')];
const extra = targetDirs.filter((p) => fs.existsSync(p)).join(path.delimiter);
if (extra !== '') {
  process.env.PATH = `${extra}${path.delimiter}${process.env.PATH}`;
}

const m = require(path.join(root, 'native', 'omni_napi.node'));
const call = (method, params) => m.call(JSON.stringify({ method, params }));

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    console.error(`  ❌ ${label} :: ${detail}`);
    failures++;
  }
}

console.log('[1] ping');
const ping = JSON.parse(call('ping'));
check('native pong', ping.ok === true && ping.native === true, JSON.stringify(ping));

console.log('[2] tools.list（native 应为 7 工具，含 shell.run）');
const tools = JSON.parse(call('tools.list'));
const names = tools.tools.map((t) => t.name);
check('ok', tools.ok === true, JSON.stringify(tools));
check('7 工具', names.length === 7, `got ${names.length}: ${names.join(',')}`);
check('含 shell.run', names.includes('shell.run'), names.join(','));

console.log('[3] approval.check');
const appr = JSON.parse(
  call('approval.check', { name: 'shell.run', args: { command: 'echo hi' } }),
);
check(
  '返回 decision',
  appr.ok === true && appr.decision && appr.decision.decision === 'allow',
  JSON.stringify(appr),
);

console.log('[4] session.submit（user 输入 → 应产出 op）');
const sub = JSON.parse(
  call('session.submit', {
    submission: { kind: 'userInput', text: '你好，native 内核' },
  }),
);
check(
  'ok + ops 数组',
  sub.ok === true && Array.isArray(sub.ops),
  JSON.stringify(sub).slice(0, 200),
);

console.log('[5] context.render');
const ctx = JSON.parse(call('context.render'));
check(
  'tokens + context',
  ctx.ok === true && typeof ctx.tokens === 'number' && typeof ctx.context === 'string',
  JSON.stringify(ctx).slice(0, 150),
);

console.log('[6] tool_call shell.run（OS 沙箱包装 + 真执行）');
const tc = JSON.parse(
  call('tool_call', { name: 'shell.run', args: { command: 'echo os-sandbox-e2e' }, callId: 't1' }),
);
check('ok', tc.ok === true, JSON.stringify(tc).slice(0, 400));
check('被 OS 沙箱包装', tc.wrapped === true, `wrapped=${tc.wrapped}`);
check('输出正确', tc.output.includes('os-sandbox-e2e'), tc.output);
check(
  'op 流完整',
  Array.isArray(tc.ops) && tc.ops.some((op) => op.kind === 'toolResult'),
  JSON.stringify(tc.ops).slice(0, 200),
);

console.log('[6b] 危险命令 → 策略沙箱拦截（fail-closed）');
const tcDanger = JSON.parse(
  call('tool_call', { name: 'shell.run', args: { command: 'rm -rf /tmp/x' }, callId: 't1d' }),
);
check('被拒', tcDanger.ok === false, JSON.stringify(tcDanger).slice(0, 300));

console.log('[7] tool_call echo');
const tc2 = JSON.parse(
  call('tool_call', { name: 'echo', args: { text: 'native-echo' }, callId: 't2' }),
);
check('echo 回文', tc2.ok === true && tc2.output.includes('native-echo'), JSON.stringify(tc2));

console.log('[8] 未知方法 → fail-closed');
const bad = JSON.parse(call('no.such.method'));
check('error 返回', bad.ok === false && typeof bad.error === 'string', JSON.stringify(bad));

console.log('[9] 非法 JSON → 优雅错误');
const badJson = JSON.parse(m.call('not-json{{{'));
check(
  'error 返回',
  badJson.ok === false && typeof badJson.error === 'string',
  JSON.stringify(badJson),
);

console.log(failures === 0 ? '\n🎉 ALL PASS' : `\n💥 ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
