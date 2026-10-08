/**
 * 决策引擎端口 + Laya 适配器单测。
 *
 * 锁死两件事：
 *   ① **fail-open**：Laya 后端不可用（解释器不存在 / 未装 `laya` / 调用失败 / 超时）时
 *      `isAvailable()` 返回 false、`decide` 返回 `{ available:false }` 且**不抛错**
 *      —— 决策引擎是质量信号，不得阻断主流程；
 *   ② **端口契约**：`noul` 原语返回 [0,1] 概率、`available:false` 时 `answers` 为空对象，
 *      调用方无需区分「后端坏了」与「后端没装」。
 *
 * 真实后端（项目内 venv + 权重）的端到端验证在 `tests/integration/layaBackend.test.ts`：
 * 那里会真跑 torch 前向，故必须按需跳过而不是放进单元层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayaDecisionEngine } from '../../src/adapters/laya/layaDecisionEngine.js';
import type {
  DecisionEngine,
  DecisionRequest,
  DecisionResponse,
} from '../../src/ports/decision/decisionEngine.js';

/** 一定不存在的解释器路径（用于锁 fail-open，不依赖机器是否装有 Python）。 */
const MISSING_PYTHON = 'this-python-does-not-exist-xyz';

/** 替身决策引擎（返回固定 noul 概率），用于验证端口契约。 */
class StubDecisionEngine implements DecisionEngine {
  /** 端口名。 */
  public readonly name = 'stub';

  /** @returns 始终可用。 */
  public isAvailable(): boolean {
    return true;
  }

  /**
   * @param request 决策请求。
   * @returns 首题 noul=0.9 的答案。
   */
  public async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const firstKey = Object.keys(request.questions)[0] ?? 'passTest';
    return { answers: { [firstKey]: { noul: 0.9 } }, available: true };
  }
}

test('StubDecisionEngine：noul 原语返回概率', async () => {
  const engine = new StubDecisionEngine();
  const response = await engine.decide({
    state: 's',
    questions: { passTest: { kind: 'noul', instructions: 'i' } },
  });
  assert.strictEqual(response.available, true);
  assert.strictEqual(response.answers.passTest?.noul, 0.9);
});

test('LayaDecisionEngine（热进程路径）：解释器不存在时 fail-open 不抛错', async () => {
  const engine = new LayaDecisionEngine({ pythonPath: MISSING_PYTHON, warmupWaitMs: 300 });
  try {
    assert.strictEqual(await engine.isAvailable(), false);
    const response = await engine.decide({
      state: 'x',
      questions: { q: { kind: 'noul', instructions: '?' } },
    });
    assert.strictEqual(response.available, false);
    assert.deepStrictEqual(response.answers, {});
    assert.match(response.note ?? '', /fail-open/);
  } finally {
    engine.dispose();
  }
});

test('LayaDecisionEngine（单发路径）：解释器不存在时同样 fail-open', async () => {
  const engine = new LayaDecisionEngine({
    pythonPath: MISSING_PYTHON,
    warm: false,
    timeoutMs: 2000,
  });
  try {
    assert.strictEqual(await engine.isAvailable(), false);
    const response = await engine.decide({
      state: 'x',
      questions: {
        choice: { kind: 'choice', instructions: '选一个', criteria: { yes: '', no: '' } },
      },
    });
    assert.strictEqual(response.available, false);
    assert.deepStrictEqual(response.answers, {});
  } finally {
    engine.dispose();
  }
});

test('LayaDecisionEngine：解释器是「裸命令名」且不在 PATH 时，也如实 fail-open（不谎报加载中）', async () => {
  // 覆盖「同步判定」覆盖不到的那一半：裸命令名（如 Windows 兜底的 `python`）无法同步判断存在性，
  // 只能等 spawn 的 ENOENT 异步回来——这一支同样必须给出真原因，而不是「仍在加载」。
  const engine = new LayaDecisionEngine({
    pythonPath: 'definitely-missing-python-name-xyz',
    warm: true,
    warmupWaitMs: 500,
  });
  try {
    assert.strictEqual(await engine.isAvailable(), false);
    const response = await engine.decide({
      state: 'x',
      questions: { q: { kind: 'noul', instructions: '?' } },
    });
    assert.strictEqual(response.available, false);
    assert.match(response.note ?? '', /fail-open/);
  } finally {
    engine.dispose();
  }
});

test('LayaDecisionEngine（单发路径）：超时真的会被杀掉并 fail-open（不得永不返回）', async () => {
  // 2026-10-07 评审发现的真缺陷：这里原先用 `AsyncChildProcess.execFileAsync(..., { timeout })`，
  // 而 Node 的 `spawn` **不支持** `timeout` 选项（只有 `exec`/`execFile` 支持），也没有任何计时器
  // ⇒ 超时形同虚设：网络卡住或 Python 挂死时 `decide` 永不返回，与 fail-open 契约冲突。
  // 本判据用「永不回帧的替身解释器」把这条钉死。
  const root = mkdtempSync(join(tmpdir(), 'laya-timeout-'));
  const script = join(root, 'neverAnswers.cjs');
  writeFileSync(script, 'setTimeout(() => {}, 10000);\n', 'utf8');
  const engine = new LayaDecisionEngine({
    pythonPath: process.execPath,
    scriptPath: script,
    warm: false,
    timeoutMs: 400,
  });
  try {
    // 探测本身也会超时 → 不可用；这里直接走 decide 的完整路径，验证「有界返回」。
    const started = Date.now();
    const response = await engine.decide({
      state: 'x',
      questions: { q: { kind: 'noul', instructions: '?' } },
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(response.available, false);
    assert.ok(elapsed < 5000, `超时应按 timeoutMs 有界返回（实测 ${elapsed}ms）`);
  } finally {
    engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('LayaDecisionEngine：负结果按 availabilityRetryMs 过期重探，正结果永久缓存', async () => {
  // 判据口径（2026-10-07 评审订正）：原判据用「第二次探测更快」来证明缓存，但探针本身只要
  // 5–26ms，无缓存也能过——是**假判据**。现在改成**探针进程计数**：替身解释器每被起一次就往
  // 标记文件追加一行，「缓存是否生效」于是变成可以直接数出来的事实。
  const root = mkdtempSync(join(tmpdir(), 'laya-probe-count-'));
  const marker = join(root, 'probes.log');
  const script = join(root, 'fakeProbe.cjs');
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.LAYA_PROBE_MARKER, 'x\\n');",
      "process.stdout.write(JSON.stringify({ available: false }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  const savedMarker = process.env['LAYA_PROBE_MARKER'];
  process.env['LAYA_PROBE_MARKER'] = marker;
  /** 数一数替身解释器被起了几次。 */
  const probeCount = (): number =>
    existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0;
  try {
    // ① 负结果缓存未过期 ⇒ 第二次 isAvailable 不得再起进程。
    const cachedEngine = new LayaDecisionEngine({
      pythonPath: process.execPath,
      scriptPath: script,
      warm: false,
      timeoutMs: 5000,
      availabilityRetryMs: 60_000,
    });
    try {
      assert.strictEqual(await cachedEngine.isAvailable(), false);
      assert.strictEqual(await cachedEngine.isAvailable(), false);
      assert.strictEqual(
        probeCount(),
        1,
        '负结果在缓存窗口内不得重探（每次重探都要起一个 Python 进程）',
      );
    } finally {
      cachedEngine.dispose();
    }

    // ② 负结果缓存窗口内**确实被跳过**：窗口设 120ms，两次调用落在同一窗口内 ⇒ 仍只有 1 次探针；
    //    窗口过期后再探 ⇒ 变 2 次。（二轮评审指出：只测 `availabilityRetryMs: 0` 等于只证明了
    //    「关掉缓存时不缓存」，没有证明窗口本身。）
    const windowEngine = new LayaDecisionEngine({
      pythonPath: process.execPath,
      scriptPath: script,
      warm: false,
      timeoutMs: 5000,
      availabilityRetryMs: 120,
    });
    try {
      assert.strictEqual(await windowEngine.isAvailable(), false);
      assert.strictEqual(await windowEngine.isAvailable(), false);
      assert.strictEqual(probeCount(), 2, '窗口内的第二次调用必须命中负缓存（不重探）');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.strictEqual(await windowEngine.isAvailable(), false);
      assert.strictEqual(probeCount(), 3, '窗口过期后必须重探');
    } finally {
      windowEngine.dispose();
    }

    // ③ availabilityRetryMs=0 ⇒ 每次 isAvailable 都重探（一次探测抖动不得把 Laya 判死）。
    const retryEngine = new LayaDecisionEngine({
      pythonPath: process.execPath,
      scriptPath: script,
      warm: false,
      timeoutMs: 5000,
      availabilityRetryMs: 0,
    });
    try {
      assert.strictEqual(await retryEngine.isAvailable(), false);
      assert.strictEqual(await retryEngine.isAvailable(), false);
      assert.strictEqual(probeCount(), 5, '负结果过期后应自动重探（合计 1 + 2 + 2 次）');
    } finally {
      retryEngine.dispose();
    }

    // ④ 正结果永久缓存：即使把重试窗口设为 0，可用的后端也只被探测一次。
    const okScript = join(root, 'fakeProbeOk.cjs');
    writeFileSync(
      okScript,
      [
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.LAYA_PROBE_MARKER, 'y\\n');",
        "process.stdout.write(JSON.stringify({ available: true }) + '\\n');",
      ].join('\n'),
      'utf8',
    );
    const okEngine = new LayaDecisionEngine({
      pythonPath: process.execPath,
      scriptPath: okScript,
      warm: false,
      timeoutMs: 5000,
      availabilityRetryMs: 0,
    });
    try {
      assert.strictEqual(await okEngine.isAvailable(), true);
      assert.strictEqual(await okEngine.isAvailable(), true);
      assert.strictEqual(probeCount(), 6, '正结果永久缓存：可用后端只探一次');
    } finally {
      okEngine.dispose();
    }
  } finally {
    if (savedMarker === undefined) {
      delete process.env['LAYA_PROBE_MARKER'];
    } else {
      process.env['LAYA_PROBE_MARKER'] = savedMarker;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
