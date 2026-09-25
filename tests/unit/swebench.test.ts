import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Swebench, type SweTask } from '../../src/eval/index.js';
import { ScriptedModel } from '../../src/eval/index.js';

// 最小自包含任务（sumUpTo 边界差一），用于端到端验证。
const SUM_BUG = `function sumUpTo(n) {
  let s = 0;
  for (let i = 1; i < n; i++) {
    s += i;
  }
  return s;
}
module.exports = { sumUpTo };
`;
const SUM_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,5 +1,5 @@
 function sumUpTo(n) {
   let s = 0;
-  for (let i = 1; i < n; i++) {
+  for (let i = 1; i <= n; i++) {
     s += i;
   }
`;
const SUM_TEST = `const { sumUpTo } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(sumUpTo(5), 15);
console.log('PASS');
`;

const TASK: SweTask = {
  id: 'sum',
  prompt: '修复 sumUpTo 的边界差一',
  seedFiles: { 'bug.js': SUM_BUG, 'test.js': SUM_TEST },
  evalCmd: 'node test.js',
  goldPatch: SUM_FIX,
  script: [
    { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
    { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: SUM_FIX } }] },
    { text: '已修复' },
  ],
};

// ---------- 纯函数评分 ----------

test('scoreSweResult: 退出码 0 → 通过', () => {
  assert.strictEqual(Swebench.scoreSweResult(0), true);
});

test('scoreSweResult: 非 0 退出码 → 不通过', () => {
  assert.strictEqual(Swebench.scoreSweResult(1), false);
  assert.strictEqual(Swebench.scoreSweResult(7), false);
});

test('runEval: 退出码 0 如实返回 0', () => {
  assert.strictEqual(Swebench.runEval('node -e "process.exit(0)"', tmpdir()), 0);
});

test('runEval: 非 0 退出码如实返回状态码', () => {
  assert.strictEqual(Swebench.runEval('node -e "process.exit(7)"', tmpdir()), 7);
});

// ---------- 对照（评分器有效性，fail-closed）----------

test('runGoldControl: 直接套 goldPatch → 必过（评分器不假阴）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swe-gold-'));
  try {
    const r = await Swebench.runGoldControl(TASK, ws);
    assert.strictEqual(r.passed, true, `gold 应过: ${r.reason ?? ''}`);
    assert.strictEqual(r.evalExitCode, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runNegativeControl: 仅 seed 不修复 → 必不过（评分器不假阳）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swe-neg-'));
  try {
    const r = await Swebench.runNegativeControl(TASK, ws);
    assert.strictEqual(r.passed, false, '阴性对照竟判过，任务定义有误');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runControls: 阳性全过 + 阴性全不过 → valid=true', async () => {
  const c = await Swebench.runControls([TASK]);
  assert.strictEqual(c.valid, true);
  assert.strictEqual(c.gold.length, 1);
  assert.strictEqual(c.negative.length, 1);
});

// ---------- 确定性基建端到端（read → apply_patch → test → score）----------

test('runSweTask(scripted): ScriptedModel 修复后 evalCmd 通过', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swe-e2e-'));
  try {
    const model = new ScriptedModel(TASK.script ?? [], '任务完成');
    const r = await Swebench.runSweTask(TASK, ws, model, 'scripted');
    assert.strictEqual(r.passed, true, `基建端到端应过: ${r.reason ?? ''}`);
    assert.strictEqual(r.mode, 'scripted');
    assert.ok(r.steps >= 2, `步数应 >=2，实际 ${r.steps}`);
    assert.strictEqual(r.evalExitCode, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
