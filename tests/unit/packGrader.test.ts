/**
 * H1（技能包分级）判据 —— 商业化报告 §阶段 3 原文：
 * 「静态权限扫描 + 沙箱运行 + 差异测试，产出 A/B/C 评级——**评级即门禁输出，不是人工标签**」。
 *
 * ## 判据要钉死什么
 *
 * 1. **三档都可达**（防"永远 A"或"永远 C"这种没信息量的实现）：同一份包，只改**声明**或**沙箱结论**
 *    就能在 A/B/C 之间移动；
 * 2. **未声明能力一票 C**（差异测试的价值所在：说一套做一套是市场里最贵的风险）；
 * 3. **沙箱未跑通一票 C**（fail-closed：判据坏掉不等于放行；缺沙箱结论的默认值必须导致 C）；
 * 4. **致命证据一票 C**（动态求值 / 原生扩展：静态扫描本就覆盖不了它们）；
 * 5. **只降不升**：声明多于实做**不降级**（保守声明不是风险），而"扫不到"绝不单独构成 A；
 * 6. **证据可复核**：报告里逐条给出扫描发现（含文件/行号/片段）与差异两侧，不是只给一个字母。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PackGrader } from '../../src/plugin/packGrader.js';
import { PackStaticScanner } from '../../src/plugin/packStaticScanner.js';
import type { PackCapability } from '../../src/plugin/packStaticScanner.js';

/**
 * 造包内文件表。
 * @param entries 文件名与内容
 * @returns 文件表
 */
function files(...entries: readonly (readonly [string, string])[]): Map<string, string> {
  return new Map(entries);
}

/** 干净包（只用包内计算，无危险能力证据）。 */
const CLEAN = files(
  ['package.json', '{"name":"clean-pack","version":"1.0.0"}'],
  ['index.js', 'export function run(input) {\n  return input.split("").reverse().join("");\n}\n'],
  ['README.md', '这个包会做字符串反转。'],
);

test('H1 评级三档可达：同包只改声明/沙箱结论即在 A、B、C 间移动（不是恒定标签）', () => {
  // A：干净包 + 沙箱跑通 + 无声明能力。
  const a = PackGrader.grade({
    files: CLEAN,
    declared: [],
    sandbox: { ran: true, level: 'in-process' },
  });
  assert.strictEqual(a.rating, 'A', JSON.stringify(a.reasons));
  assert.strictEqual(a.installable, true);
  assert.match(a.reasons.join(''), /未扫出危险能力证据/);

  // B：包内起进程（high）且**已声明** + 沙箱跑通。
  const withProcess = files([
    'index.js',
    'import { execSync } from "node:child_process";\nexport const run = () => execSync("ls");\n',
  ]);
  const b = PackGrader.grade({
    files: withProcess,
    declared: ['process'],
    sandbox: { ran: true, level: 'os-sandbox' },
  });
  assert.strictEqual(b.rating, 'B', JSON.stringify(b.reasons));
  assert.strictEqual(b.installable, true, 'B 仍可安装（标注需授权）');
  assert.match(b.reasons.join(''), /已声明的高危能力：process/);

  // C：同一份包**不声明** process ⇒ 差异测试一票否决。
  const c = PackGrader.grade({ files: withProcess, declared: [], sandbox: { ran: true } });
  assert.strictEqual(c.rating, 'C');
  assert.strictEqual(c.installable, false, 'C 不可安装');
  assert.match(c.reasons.join(''), /存在未声明能力：process/);
});

test('H1 差异测试：未声明能力一票 C；声明多于实做**不降级**（只降不升）', () => {
  const network = files(['net.js', 'export const go = () => fetch("https://example.com");\n']);
  // 未声明 network ⇒ C。
  const undeclared = PackGrader.grade({ files: network, declared: [], sandbox: { ran: true } });
  assert.strictEqual(undeclared.rating, 'C');
  assert.deepStrictEqual(undeclared.evidence.diff.undeclared, ['network']);
  // 声明了 network ⇒ B（高危已声明）。
  const declared = PackGrader.grade({
    files: network,
    declared: ['network'],
    sandbox: { ran: true },
  });
  assert.strictEqual(declared.rating, 'B');
  assert.deepStrictEqual(declared.evidence.diff.undeclared, []);

  // 声明一堆没用到的高危能力：**不降级**，且差异表如实列出"声明未用"。
  const over = PackGrader.grade({
    files: CLEAN,
    declared: ['process', 'network', 'fs-write'],
    sandbox: { ran: true },
  });
  assert.strictEqual(over.rating, 'A', '保守声明不是风险，不得降级');
  assert.deepStrictEqual(over.evidence.diff.declaredUnused, ['fs-write', 'network', 'process']);
  assert.match(over.reasons.join(''), /声明了但未扫到（保守声明，不影响评级）/);
});

test('H1 fail-closed：沙箱未跑通 / 缺沙箱结论 ⇒ C（判据坏掉不等于放行）', () => {
  const noSandbox = PackGrader.grade({ files: CLEAN, declared: [], sandbox: { ran: false } });
  assert.strictEqual(noSandbox.rating, 'C');
  assert.match(noSandbox.reasons.join(''), /沙箱未跑通/);
  assert.strictEqual(noSandbox.installable, false);

  const explicit = PackGrader.grade({
    files: CLEAN,
    declared: [],
    sandbox: { ran: false, reason: 'wasm 运行时不可用' },
  });
  assert.match(explicit.reasons.join(''), /wasm 运行时不可用/);
});

test('H1 致命证据一票 C：动态求值 / 原生扩展（即使已声明也不放行）', () => {
  const evalPack = files(['x.js', 'export const run = (s) => eval(s);\n']);
  const graded = PackGrader.grade({ files: evalPack, declared: ['eval'], sandbox: { ran: true } });
  assert.strictEqual(graded.rating, 'C', '动态求值不可评为 A/B');
  assert.match(graded.reasons.join(''), /存在致命能力证据：eval/);

  const nativePack = files(['package.json', '{"gypfile":true}'], ['binding.gyp', '{"targets":[]}']);
  const nativeGraded = PackGrader.grade({
    files: nativePack,
    declared: ['native-addon'],
    sandbox: { ran: true },
  });
  assert.strictEqual(nativeGraded.rating, 'C');
});

test('H1 证据可复核：报告给出扫描发现（文件/行号/片段）与差异两侧，而不是只给字母', () => {
  const pack = files(
    ['a.js', 'const x = 1;\n'],
    ['b.js', 'import { writeFileSync } from "node:fs";\nwriteFileSync("out.txt", "x");\n'],
  );
  const report = PackGrader.grade({ files: pack, declared: ['fs-write'], sandbox: { ran: true } });
  assert.strictEqual(report.evidence.scan.scannedFiles, 2);
  // 该能力在**两行**都有真实使用证据：import 行与调用行。判据要求"行号指向真实使用处"，
  // 第一版只断言首个发现的行号 ⇒ 把 import 行当成错报（那是判据自己的错，不是扫描器的）。
  const fsFindings = report.evidence.scan.findings.filter((f) => f.capability === 'fs-write');
  assert.deepStrictEqual(
    fsFindings.map((f) => f.line),
    [1, 2],
    'import 行与调用行都应被如实报出',
  );
  const finding = fsFindings[1];
  assert.ok(finding !== undefined);
  assert.strictEqual(finding.file, 'b.js');
  assert.match(finding.snippet, /writeFileSync/);
  assert.deepStrictEqual(report.evidence.diff.undeclared, []);
  assert.deepStrictEqual(report.evidence.sandbox, { ran: true });
  // 确定性：同输入两次评级与证据逐字段一致。
  assert.deepStrictEqual(
    PackGrader.grade({ files: pack, declared: ['fs-write'], sandbox: { ran: true } }),
    report,
  );
});

test('H1 扫描器判据：注释与文档里的"提及"不算证据；import 的模块名算证据', () => {
  // ① 注释里提到 eval / child_process ⇒ **不算**证据（否则市场评级会狼来了）。
  const mentioned = PackStaticScanner.scan(
    files([
      'doc.js',
      '// 这里绝不用 eval() 也不用 child_process\n/* spawn( 也别用 */\nexport const a = 1;\n',
    ]),
  );
  assert.deepStrictEqual(mentioned.findings, [], '注释里的提及不得算证据');
  assert.deepStrictEqual(mentioned.capabilities, []);

  // ② 字符串里的 `eval(`（错误消息）⇒ 不算；但 `require("child_process")` ⇒ **算**（stringOk 规则）。
  const mixed = PackStaticScanner.scan(
    files(['m.js', 'throw new Error("bad eval( usage");\nconst cp = require("child_process");\n']),
  );
  assert.deepStrictEqual(
    mixed.capabilities,
    ['process'],
    '错误消息里的 eval( 不算证据，但 import 危险模块必须算',
  );
  assert.strictEqual(mixed.findings[0]?.line, 2, '行号必须指向真正的 require 行');

  // ③ 严重级归并：eval 是 critical，故 hasCritical=true（分级据此一票否决）。
  const critical = PackStaticScanner.scan(files(['c.js', 'const f = new Function("return 1");\n']));
  assert.strictEqual(critical.hasCritical, true);
  assert.deepStrictEqual(critical.capabilities, ['eval']);

  // ④ 非可扫描扩展名只统计不解析（图片/二进制不该被当源码）。
  const ignores = PackStaticScanner.scan(files(['logo.png', 'eval(child_process)']));
  assert.strictEqual(ignores.scannedFiles, 0);
  assert.deepStrictEqual(ignores.findings, []);
});

test('H1 能力集合完整：六类能力都能被扫出（防规则表漏项）', () => {
  const table: readonly (readonly [PackCapability, string])[] = [
    ['process', 'require("child_process")'],
    ['fs-write', 'writeFileSync("a", "b")'],
    ['network', 'fetch("https://x")'],
    ['eval', 'eval("1")'],
    ['env', 'process.env.HOME'],
    ['abs-path', 'const p = "/etc/passwd"'],
    ['native-addon', 'require("./native.node")'],
  ];
  for (const [capability, code] of table) {
    const report = PackStaticScanner.scan(files(['t.js', `${code}\n`]));
    assert.ok(
      report.capabilities.includes(capability),
      `规则表必须能识别 ${capability}（样例：${code}）`,
    );
  }
});

test('H1 最小权限边界：动态验证不完整 ⇒ **封顶 B**（不得因"验不动"而放行到 A）', () => {
  const riskyButDeclared = files([
    'index.js',
    'const { execSync } = require("node:child_process");\nmodule.exports = { run: () => execSync("ls") };\n',
  ]);
  const minimal = {
    ran: false,
    minimalAuthority: true,
    level: 'vm',
    reason: '沙箱以最小权限运行（不提供 require）',
  } as const;
  // 声明了 process 且实际使用 ⇒ B（可受限运行），且原因里明确写出"动态验证不完整"。
  const b = PackGrader.grade({ files: riskyButDeclared, declared: ['process'], sandbox: minimal });
  assert.strictEqual(b.rating, 'B', JSON.stringify(b.reasons));
  assert.match(b.reasons.join(''), /动态验证不完整/);
  assert.strictEqual(b.installable, true);

  // 同一份包**不声明** ⇒ 仍是 C（未声明能力优先于"验不动"）。
  const c = PackGrader.grade({ files: riskyButDeclared, declared: [], sandbox: minimal });
  assert.strictEqual(c.rating, 'C');
  assert.match(c.reasons.join(''), /存在未声明能力：process/);
  assert.match(c.reasons.join(''), /动态验证不完整/);

  // 干净包 + "验不动" ⇒ 也只能 B（**绝不 A**：A 要求动态验证真的跑通）。
  const cleanIncomplete = PackGrader.grade({ files: CLEAN, declared: [], sandbox: minimal });
  assert.strictEqual(cleanIncomplete.rating, 'B');
  assert.match(cleanIncomplete.reasons.join(''), /动态验证不完整/);
  // 对照：同一干净包沙箱跑通 ⇒ A（说明上面的 B 来自"验不动"，不是来自包本身）。
  assert.strictEqual(
    PackGrader.grade({ files: CLEAN, declared: [], sandbox: { ran: true, level: 'vm' } }).rating,
    'A',
  );

  // 非最小权限的普通沙箱失败（如 trap）⇒ C，不享受"封顶 B"待遇。
  const trapped = PackGrader.grade({
    files: CLEAN,
    declared: [],
    sandbox: { ran: false, reason: '[trap] 执行超时' },
  });
  assert.strictEqual(trapped.rating, 'C');
  assert.match(trapped.reasons.join(''), /沙箱未跑通/);
});
