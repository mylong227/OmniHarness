/**
 * 浏览器强制开关的**机制判据**（2026-10-11，与 `tests/unit/requireSwitches.test.ts` 同一件事的 web 侧）。
 *
 * ## 为什么需要它
 *
 * `tests/**` 的跳过点早就有强制开关（缺环境且开关开 ⇒ 失败而不是跳过），但 `web/test/**` 不在扫描面内：
 * **8 个**浏览器类判据可以静默跳过而无人管 —— "跳过即假绿"。本轮把 web 侧全部接上开关，
 * 并在这里把开关的**两条路径都验一遍**：
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 有浏览器 ⇒ 不跳过 | 本机明明能跑却照样跳（首版就是这个 bug：把"未设开关"当成跳过） |
 * | ② | 缺浏览器且**未**要求 ⇒ 给可读原因（含 OMNI_CHROME_PATH 提示） | 静默跳过无痕迹 |
 * | ③ | 缺浏览器且 `OMNI_REQUIRE_BROWSER=1` ⇒ **不返回原因**（调用方随后断言能力存在 ⇒ 失败） | 开关没有牙，CI 上仍可假绿 |
 * | ④ | **端到端**：用 `OMNI_BROWSER_NONE=1` 钩子真跑一个浏览器判据 —— 开关关 ⇒ 子进程 skip 且 exit 0；开关开 ⇒ 子进程**失败** | ③ 只是"函数返回值对不对"，没有证明调用方真的会红 |
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './browserHarness.mjs';
import { skipReasonFor, requireBrowser } from './browserSwitch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** 在给定环境下真跑一个浏览器类判据。 */
function runNarrowJudge(env) {
  // 必须剥掉 node 给「测试子进程」设的环境变量：`node --test` 在 NODE_TEST_CONTEXT 存在时
  // 不再输出完整 TAP 摘要 ⇒ 子进程的 skip/fail 就看不出来了（本判据第一次跑就栽在这）。
  const clean = { ...process.env, OMNI_BROWSER_NONE: '1', ...env };
  delete clean.NODE_TEST_CONTEXT;
  delete clean.NODE_OPTIONS;
  return spawnSync(
    process.execPath,
    ['--test', '--test-timeout=60000', join(HERE, 'narrowReflow.test.mjs')],
    { cwd: REPO_ROOT, encoding: 'utf8', env: clean },
  );
}

test('① 有浏览器 ⇒ 不跳过（首版把"未设开关"当成跳过，本机有 Chrome 也照跳）', () => {
  // 本判据自身在**本机有浏览器**的前提下运行；钩子关掉浏览器的情况由 ④ 覆盖。
  const saved = process.env.OMNI_BROWSER_NONE;
  delete process.env.OMNI_BROWSER_NONE;
  try {
    const found = findBrowser();
    assert.notStrictEqual(found, null, '本机应能找到一个浏览器（否则请设 OMNI_CHROME_PATH）');
    assert.strictEqual(skipReasonFor(true), null, '有浏览器时不得跳过');
  } finally {
    if (saved !== undefined) process.env.OMNI_BROWSER_NONE = saved;
  }
});

test('② 缺浏览器且未要求 ⇒ 给可读跳过原因', () => {
  const saved = process.env.OMNI_REQUIRE_BROWSER;
  delete process.env.OMNI_REQUIRE_BROWSER;
  try {
    const reason = skipReasonFor(false);
    assert.ok(reason !== null, '缺浏览器时应给出跳过原因');
    assert.match(reason, /OMNI_CHROME_PATH/u, '原因里要写清怎么指定浏览器');
  } finally {
    if (saved !== undefined) process.env.OMNI_REQUIRE_BROWSER = saved;
  }
});

test('③ 缺浏览器且 OMNI_REQUIRE_BROWSER=1 ⇒ 不跳过（交给断言失败）', () => {
  const saved = process.env.OMNI_REQUIRE_BROWSER;
  process.env.OMNI_REQUIRE_BROWSER = '1';
  try {
    assert.strictEqual(requireBrowser(), true, '开关应被读到');
    assert.strictEqual(
      skipReasonFor(false),
      null,
      '要求必跑时不得返回跳过原因 ⇒ 调用方的 assert.ok(browser !== null) 会失败',
    );
  } finally {
    if (saved === undefined) delete process.env.OMNI_REQUIRE_BROWSER;
    else process.env.OMNI_REQUIRE_BROWSER = saved;
  }
});

test('④ 端到端：真跑判据 —— 开关关 ⇒ 子进程 skip 且 exit 0；开关开 ⇒ 子进程失败', () => {
  // 注意：node:test 的 TAP 摘要可能走 stderr（不是我们的契约），故断言一律用**合并流**。
  const off = runNarrowJudge({});
  const offAll = `${off.stdout}\n${off.stderr}`;
  assert.strictEqual(off.status, 0, `开关关时应正常结束（跳过）:\n${offAll}`);
  assert.match(offAll, /# skipped 1/u, '开关关时子进程应显式跳过 1 例（而不是假装通过）');
  assert.match(offAll, /未找到本机 Chrome\/Edge/u, '跳过原因应可读');

  const on = runNarrowJudge({ OMNI_REQUIRE_BROWSER: '1' });
  const onAll = `${on.stdout}\n${on.stderr}`;
  assert.notStrictEqual(
    on.status,
    0,
    `开关开且无浏览器时子进程必须失败（否则 CI 上仍会假绿）:\n${onAll}`,
  );
  assert.match(
    onAll,
    /OMNI_REQUIRE_BROWSER=1 时必须有浏览器|未找到本机 Chrome/u,
    '失败原因应指向缺浏览器，而不是别的偶发错误',
  );
});
