// swebenchTasks.mjs —— SWE-bench 风格「能力基准」本地子集（共享任务模块，U5）。
//
// 被两份脚本复用：
//   - benchmark/capability_swebench.mjs：基建套件 + 阳性/阴性对照（零 key 跑通 10/10）。
//   - evals/live/bench.mjs：--swebench 开关加载本子集，经 ScriptedModel replay 零 key
//     跑 Pass@k 规模化门禁（联网子集另由 --swebench-remote 加载）。
//
// 统一任务形状 SweTask：{ id, prompt, seedFiles(bug+test), evalCmd, script(replay), goldPatch }。
// 转 EvalTask 时 expect.run.cmd = evalCmd（FAIL_TO_PASS 判定 = evalCmd 退出码 0）。
//
// 零依赖（仅 node: 内置）。

/**
 * 单条 SWE 风格 bug 修复任务（声明式、自包含）。
 * @typedef {Object} SweTask
 * @property {string} id
 * @property {string} [description]
 * @property {string} prompt
 * @property {Readonly<Record<string, string>>} seedFiles
 * @property {string} evalCmd
 * @property {ReadonlyArray<{ toolCalls?: ReadonlyArray<unknown>, text?: string }>} [script]
 * @property {string} [goldPatch]
 * @property {string} [finalText]
 */

// ---------- 自包含 bug 修复任务（真实、可离线）----------
// 每个任务 = 带 bug 源码 + 失败测试 + 一套 goldPatch（统一 diff）。

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
assert.strictEqual(sumUpTo(1), 1);
assert.strictEqual(sumUpTo(100), 5050);
console.log('PASS');
`;

const GREET_BUG = `function greet(name) {
  return 'Hello, ' + name.toUpperCase();
}
module.exports = { greet };
`;
const GREET_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function greet(name) {
-  return 'Hello, ' + name.toUpperCase();
+  return 'Hello, ' + (name ? name.toUpperCase() : '');
 }
`;
const GREET_TEST = `const { greet } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(greet(null), 'Hello, ');
assert.strictEqual(greet('A'), 'Hello, A');
console.log('PASS');
`;

const AVG_BUG = `function avg(a, b) {
  return (a - b) / 2;
}
module.exports = { avg };
`;
const AVG_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function avg(a, b) {
-  return (a - b) / 2;
+  return (a + b) / 2;
 }
`;
const AVG_TEST = `const { avg } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(avg(4, 6), 5);
assert.strictEqual(avg(10, 20), 15);
console.log('PASS');
`;

const SORT_BUG = `function sortAsc(arr) {
  return arr.sort((a, b) => b - a);
}
module.exports = { sortAsc };
`;
const SORT_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function sortAsc(arr) {
-  return arr.sort((a, b) => b - a);
+  return arr.sort((a, b) => a - b);
 }
`;
const SORT_TEST = `const { sortAsc } = require('./bug.js');
const assert = require('assert');
assert.deepStrictEqual(sortAsc([3, 1, 2]), [1, 2, 3]);
assert.deepStrictEqual(sortAsc([5, 5, 1]), [1, 5, 5]);
console.log('PASS');
`;

// ---------- 6 个新增 bug 类（扩大能力覆盖广度）----------

const FIRSTN_BUG = `function firstN(arr, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(arr[i]);
  }
  return out;
}
module.exports = { firstN };
`;
const FIRSTN_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,7 +1,7 @@
 function firstN(arr, n) {
   const out = [];
-  for (let i = 1; i <= n; i++) {
+  for (let i = 0; i < n; i++) {
     out.push(arr[i]);
   }
   return out;
 }
`;
const FIRSTN_TEST = `const { firstN } = require('./bug.js');
const assert = require('assert');
assert.deepStrictEqual(firstN([10, 20, 30], 2), [10, 20]);
assert.deepStrictEqual(firstN([5, 6, 7, 8], 0), []);
assert.deepStrictEqual(firstN([1, 2, 3], 3), [1, 2, 3]);
console.log('PASS');
`;

const HEAD_BUG = `function head(arr, n) {
  return arr.slice(0, n - 1);
}
module.exports = { head };
`;
const HEAD_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function head(arr, n) {
-  return arr.slice(0, n - 1);
+  return arr.slice(0, n);
 }
`;
const HEAD_TEST = `const { head } = require('./bug.js');
const assert = require('assert');
assert.deepStrictEqual(head([1, 2, 3, 4], 3), [1, 2, 3]);
assert.deepStrictEqual(head([9, 8, 7], 1), [9]);
console.log('PASS');
`;

const HASDIGIT_BUG = `function hasDigit(s) {
  return /^[0-9]/.test(s);
}
module.exports = { hasDigit };
`;
const HASDIGIT_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function hasDigit(s) {
-  return /^[0-9]/.test(s);
+  return /[0-9]/.test(s);
 }
`;
const HASDIGIT_TEST = `const { hasDigit } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(hasDigit('abc1'), true);
assert.strictEqual(hasDigit('x9y'), true);
assert.strictEqual(hasDigit('abc'), false);
console.log('PASS');
`;

const APPROX_BUG = `function approxEqual(a, b) {
  return a === b;
}
module.exports = { approxEqual };
`;
const APPROX_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function approxEqual(a, b) {
-  return a === b;
+  return Math.abs(a - b) < 1e-9;
 }
`;
const APPROX_TEST = `const { approxEqual } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(approxEqual(0.1 + 0.2, 0.3), true);
assert.strictEqual(approxEqual(1, 1), true);
assert.strictEqual(approxEqual(0.3, 0.4), false);
console.log('PASS');
`;

const ADD_BUG = `function add(a, b) {
  return a + b;
}
module.exports = { add };
`;
const ADD_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function add(a, b) {
-  return a + b;
+  return Number(a) + Number(b);
 }
`;
const ADD_TEST = `const { add } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(add('3', '4'), 7);
assert.strictEqual(add(5, 6), 11);
console.log('PASS');
`;

const ISEVEN_BUG = `function isEven(n) {
  return n % 2 === 1;
}
module.exports = { isEven };
`;
const ISEVEN_FIX = `--- a/bug.js
+++ b/bug.js
@@ -1,3 +1,3 @@
 function isEven(n) {
-  return n % 2 === 1;
+  return n % 2 === 0;
 }
`;
const ISEVEN_TEST = `const { isEven } = require('./bug.js');
const assert = require('assert');
assert.strictEqual(isEven(4), true);
assert.strictEqual(isEven(7), false);
console.log('PASS');
`;

/** 本地 SWE-bench 风格子集（10 个自包含 bug 修复任务）。 */
export const SWEBENCH_LITE_TASKS = [
  {
    id: 'off-by-one-sum',
    description: 'sumUpTo(n) 边界差一：漏加末项',
    prompt: 'bug.js 的 sumUpTo 有 off-by-one 错误，请阅读并修复，使 sumUpTo(5)===15。',
    seedFiles: { 'bug.js': SUM_BUG, 'test.js': SUM_TEST },
    evalCmd: 'node test.js',
    goldPatch: SUM_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: SUM_FIX } }] },
      { text: '已修复 sumUpTo 的边界差一，测试应通过。' },
    ],
  },
  {
    id: 'null-guard-greet',
    description: 'greet(null) 空指针崩溃',
    prompt: 'bug.js 的 greet 在 name 为 null 时崩溃，请修复使其对 null 安全。',
    seedFiles: { 'bug.js': GREET_BUG, 'test.js': GREET_TEST },
    evalCmd: 'node test.js',
    goldPatch: GREET_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: GREET_FIX } }] },
      { text: '已加 null 守卫，greet(null) 返回 "Hello, "。' },
    ],
  },
  {
    id: 'wrong-op-avg',
    description: 'avg 用减号而非加号',
    prompt: 'bug.js 的 avg 用了减法，请改为正确的平均值计算。',
    seedFiles: { 'bug.js': AVG_BUG, 'test.js': AVG_TEST },
    evalCmd: 'node test.js',
    goldPatch: AVG_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: AVG_FIX } }] },
      { text: '已把 (a-b)/2 改为 (a+b)/2。' },
    ],
  },
  {
    id: 'reversed-sort',
    description: 'sortAsc 比较器方向反了（降序而非升序）',
    prompt: 'bug.js 的 sortAsc 返回的是降序，请改为升序。',
    seedFiles: { 'bug.js': SORT_BUG, 'test.js': SORT_TEST },
    evalCmd: 'node test.js',
    goldPatch: SORT_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: SORT_FIX } }] },
      { text: '已将比较器方向改为升序 (a-b)。' },
    ],
  },
  {
    id: 'loop-start-firstN',
    description: 'firstN 循环起点差一（从 1 开始而非 0）',
    prompt: 'bug.js 的 firstN 循环从 i=1 开始，导致漏掉首元素，请改为从 0 开始。',
    seedFiles: { 'bug.js': FIRSTN_BUG, 'test.js': FIRSTN_TEST },
    evalCmd: 'node test.js',
    goldPatch: FIRSTN_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: FIRSTN_FIX } }] },
      { text: '已将循环起点改为 i=0。' },
    ],
  },
  {
    id: 'fencepost-slice',
    description: 'head 切片 fencepost 差一（n-1 而非 n）',
    prompt: 'bug.js 的 head 用 slice(0, n-1)，少取了末项，请改为 slice(0, n)。',
    seedFiles: { 'bug.js': HEAD_BUG, 'test.js': HEAD_TEST },
    evalCmd: 'node test.js',
    goldPatch: HEAD_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: HEAD_FIX } }] },
      { text: '已将 slice(0, n-1) 改为 slice(0, n)。' },
    ],
  },
  {
    id: 'regex-anchored',
    description: 'hasDigit 正则多了行首锚点 ^（只匹配开头数字）',
    prompt: 'bug.js 的 hasDigit 正则带 ^ 锚点，只能识别开头数字，请去掉锚点使其匹配任意位置数字。',
    seedFiles: { 'bug.js': HASDIGIT_BUG, 'test.js': HASDIGIT_TEST },
    evalCmd: 'node test.js',
    goldPatch: HASDIGIT_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: HASDIGIT_FIX } }] },
      { text: '已去掉 ^ 锚点。' },
    ],
  },
  {
    id: 'float-precision',
    description: 'approxEqual 用 === 比较浮点（精度误差）',
    prompt:
      'bug.js 的 approxEqual 用严格相等比较浮点，0.1+0.2 !== 0.3 会判错，请改用 epsilon 容差。',
    seedFiles: { 'bug.js': APPROX_BUG, 'test.js': APPROX_TEST },
    evalCmd: 'node test.js',
    goldPatch: APPROX_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: APPROX_FIX } }] },
      { text: '已改用 Math.abs(a-b) < 1e-9 容差。' },
    ],
  },
  {
    id: 'type-coercion',
    description: 'add 直接拼接字符串而非数值相加',
    prompt: 'bug.js 的 add 对 "3"+"4" 返回 "34"，请改为数值相加。',
    seedFiles: { 'bug.js': ADD_BUG, 'test.js': ADD_TEST },
    evalCmd: 'node test.js',
    goldPatch: ADD_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: ADD_FIX } }] },
      { text: '已改为 Number(a) + Number(b)。' },
    ],
  },
  {
    id: 'inverted-condition',
    description: 'isEven 条件取反（用 ===1 而非 ===0）',
    prompt: 'bug.js 的 isEven 用 n%2===1 判断偶数（实为奇数），请改为 ===0。',
    seedFiles: { 'bug.js': ISEVEN_BUG, 'test.js': ISEVEN_TEST },
    evalCmd: 'node test.js',
    goldPatch: ISEVEN_FIX,
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'bug.js' } }] },
      { toolCalls: [{ id: 'c2', name: 'apply_patch', arguments: { patch: ISEVEN_FIX } }] },
      { text: '已将条件改为 n % 2 === 0。' },
    ],
  },
];

/**
 * 增强提示：要求用 read_file + apply_patch 工具完成修复（规范 agent 工具使用，不泄露答案）。
 * 这是合理的 agent 引导（对标成熟 agent 的 system 指令），仅规范工具使用方式。
 */
const ENHANCE_SUFFIX =
  ' 请先用 read_file 读取 bug.js，再用 apply_patch 工具（unified diff 格式）修复。无需自行运行测试，系统会自动运行 test.js 验证修复结果。';

export function buildEnhancedTasks(tasks = SWEBENCH_LITE_TASKS) {
  return tasks.map((t) => ({ ...t, prompt: t.prompt + ENHANCE_SUFFIX }));
}

/**
 * 把 SweTask 转成 bench.mjs 的 EvalTask 形状：
 *   expect.run.cmd = evalCmd（FAIL_TO_PASS 判定 = 退出码 0）。
 * 保留 seedFiles / script / prompt，使 runTask 默认用 ScriptedModel replay 零 key 跑。
 */
export function toEvalTask(task) {
  return {
    id: task.id,
    description: task.description,
    prompt: task.prompt,
    script: task.script,
    finalText: task.finalText ?? '任务完成（swebench）',
    seedFiles: task.seedFiles,
    expect: { run: { cmd: task.evalCmd } },
  };
}
