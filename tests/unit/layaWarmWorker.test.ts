/**
 * Laya 常驻热进程单测（权威缝：**进程复用 / 超时预算 / 崩溃恢复 / 显式关闭**）。
 *
 * ## 为什么用「假子进程」而不是真 Python
 *
 * 真后端每次加载 842MB 权重（实测首帧 15.9s），放进单测既慢又不稳定；本文件用一个
 * **同构 JSONL 协议**的 Node 替身进程来锁协议与生命周期不变量——真后端的端到端验证在
 * `tests/integration/layaBackend.test.ts`（它按需自动探测项目内 venv）。
 *
 * 锁死四条：
 *   ① 复用：连续两次请求落到**同一个子进程**（pid 相同）——这正是把单次 18–62s 压到 ~0.4s 的机制；
 *   ② 冷启动预算：权重未就绪时超出预算即 fail-open（返回 `available:false`，**不抛错、不拖住回合**）；
 *   ③ 崩溃恢复：进程中途退出时在途请求被兑现为 fail-open（不永久挂起），且下一次请求会自动重启；
 *   ④ 关闭：`dispose()` 后不再重启。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayaWarmWorker } from '../../src/adapters/laya/layaWarmWorker.js';
import type { LayaWireQuestion } from '../../src/adapters/laya/layaQuestionTranslator.js';

/** 替身进程源码：与 `laya_infer.py --serve` 的线协议同构（`probe` / `warmup` / 推理三型）。 */
const FAKE_WORKER_SOURCE = `
const readline = require('node:readline');
const fs = require('node:fs');
const rl = readline.createInterface({ input: process.stdin });
const scenario = process.env.FAKE_SCENARIO || 'ok';
const marker = process.env.FAKE_MARKER || '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const answer = (req) =>
  send({
    id: req.id,
    available: true,
    answers: { q: { noul: 0.25 } },
    model: 'fake',
    pid: process.pid,
  });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  const req = JSON.parse(line);
  if (req.probe) return send({ id: req.id, available: true });
  if (req.warmup) {
    // silent：进程活着但**永不回 warmup 帧**（用于验证「加载预算必须有界」，否则加载态永久卡死）。
    if (scenario === 'silent') return;
    // slow：只拖慢「加载」本身（用于验证 waitReady 的超时分支）。
    if (scenario === 'slow') {
      return void setTimeout(
        () => send({ id: req.id, available: true, warmup: true, pid: process.pid }),
        5000,
      );
    }
    return send({ id: req.id, available: true, warmup: true, pid: process.pid });
  }
  // slow-warm：加载正常、推理很慢（用于验证「就绪后仍会超时」的 fail-open 分支）。
  if (scenario === 'slow-warm') return void setTimeout(() => answer(req), 5000);
  if (scenario === 'die-once') {
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1');
      process.exit(3);
    }
    return answer(req);
  }
  return answer(req);
});
`;

/** 推理问题集（一题 noul 足够验证协议，不涉及语义）。 */
const QUESTIONS: Readonly<Record<string, LayaWireQuestion>> = {
  q: { type: 'noul', instructions: '会不会失败？' },
};

/**
 * 造一个替身进程脚本 + 返回其路径。
 * @param root 临时目录。
 * @returns 脚本绝对路径。
 */
function writeFakeWorker(root: string): string {
  const script = join(root, 'fakeLayaWorker.cjs');
  writeFileSync(script, FAKE_WORKER_SOURCE, 'utf8');
  return script;
}

/**
 * 造一个 worker（默认短预算、长空转，便于测试）。
 * @param script 替身脚本路径。
 * @param overrides 需要覆盖的配置。
 * @returns worker 实例。
 */
function makeWorker(
  script: string,
  overrides: Partial<ConstructorParameters<typeof LayaWarmWorker>[0]> = {},
): LayaWarmWorker {
  return new LayaWarmWorker({
    // 用 node 自己当「python」：协议同构即可验证生命周期，不必依赖 Python 环境。
    pythonPath: process.execPath,
    scriptPath: script,
    modelDir: '',
    repo: 'fake',
    hfEndpoint: 'http://127.0.0.1:1',
    warmupWaitMs: 1500,
    loadTimeoutMs: 10_000,
    requestTimeoutMs: 5000,
    idleShutdownMs: 600_000,
    ...overrides,
  });
}

test('热进程：probe 可用 + 连续两次推理复用同一个子进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-'));
  const worker = makeWorker(writeFakeWorker(root));
  try {
    const probe = await worker.probe();
    assert.strictEqual(probe.available, true);
    // 冷启动窗口内的决策不排队（见下一条用例），故先显式等到就绪再验证复用。
    worker.preload();
    assert.strictEqual(await worker.waitReady(3000), true, 'warmup 帧到达后应就绪');

    const first = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    const second = await worker.decide({
      state: 'b',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(first.available, true);
    assert.strictEqual(second.available, true);
    assert.strictEqual(first.answers?.q?.noul, 0.25);
    const firstPid = (first as unknown as { pid?: number }).pid;
    const secondPid = (second as unknown as { pid?: number }).pid;
    assert.ok(firstPid !== undefined, '替身进程应回报 pid');
    assert.strictEqual(
      secondPid,
      firstPid,
      '第二次请求必须复用同一个子进程（否则每次都付加载代价）',
    );
    assert.strictEqual(worker.isReady, true, '收到 warmup/答案帧后应置为就绪');
  } finally {
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：冷启动窗口内立即 fail-open（不等待、不排队推理），且不影响后台加载', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-cold-'));
  const worker = makeWorker(writeFakeWorker(root), { requestTimeoutMs: 5000 });
  process.env['FAKE_SCENARIO'] = 'slow';
  try {
    const started = Date.now();
    const response = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(response.available, false);
    assert.match(response.note ?? '', /加载/);
    // 关键口径：未就绪时**立即**返回（早先实现会白等 1.5s，并把无人读取的推理排进 Python 队列）。
    assert.ok(elapsed < 500, `冷启动跳过必须立即返回（实测 ${elapsed}ms）`);

    // 跳过不得影响后台加载：稍后必须就绪，且就绪后能拿到真答案。
    assert.strictEqual(await worker.waitReady(8000), true, '冷启动跳过不应取消后台加载');
    const warm = await worker.decide({
      state: 'b',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(warm.available, true);
    assert.strictEqual(warm.answers?.q?.noul, 0.25);
  } finally {
    delete process.env['FAKE_SCENARIO'];
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：就绪后请求超时仍 fail-open（超时即超时，不永久挂起）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-warm-slow-'));
  const worker = makeWorker(writeFakeWorker(root), { requestTimeoutMs: 200 });
  process.env['FAKE_SCENARIO'] = 'slow-warm';
  try {
    worker.preload();
    assert.strictEqual(await worker.waitReady(5000), true, '加载正常，应就绪');
    const started = Date.now();
    const response = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(response.available, false);
    assert.match(response.note ?? '', /超时/);
    assert.ok(Date.now() - started < 2000, '超时应按 requestTimeoutMs 兑现，而不是等推理跑完');
  } finally {
    delete process.env['FAKE_SCENARIO'];
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：进程中途退出时在途请求 fail-open，重启后再次可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-crash-'));
  const marker = join(root, 'died.marker');
  const worker = makeWorker(writeFakeWorker(root));
  process.env['FAKE_SCENARIO'] = 'die-once';
  process.env['FAKE_MARKER'] = marker;
  try {
    // 先就绪，再让子进程死在「推理」这一步（die-once 场景）。
    worker.preload();
    assert.strictEqual(await worker.waitReady(5000), true, '首次加载应就绪');

    const crashed = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(crashed.available, false, '进程死亡不得让在途请求永久挂起');
    assert.match(crashed.note ?? '', /热进程/);

    // 重启并重新预热（新进程同样要加载权重）后应再次可用。
    worker.preload();
    assert.strictEqual(await worker.waitReady(5000), true, '重启后应能再次就绪');
    const recovered = await worker.decide({
      state: 'b',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(recovered.available, true, '重启后的子进程应正常作答');
    assert.strictEqual(recovered.answers?.q?.noul, 0.25);
  } finally {
    delete process.env['FAKE_SCENARIO'];
    delete process.env['FAKE_MARKER'];
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：waitReady 超时先兑现 false，随后加载完成仍会兑现就绪', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-ready-'));
  const script = writeFakeWorker(root);
  const worker = makeWorker(script, { warmupWaitMs: 120 });
  process.env['FAKE_SCENARIO'] = 'slow';
  try {
    // 先触发加载（slow 场景 warmup 帧要 5s 才到），再用 150ms 的预算等 ⇒ 必然超时。
    worker.preload();
    assert.strictEqual(
      await worker.waitReady(150),
      false,
      '超时应兑现 false（不抛错、不永久挂起）',
    );
    assert.strictEqual(worker.isReady, false);
    // 超时不影响后台加载：同一 worker 随后仍会就绪（等待者兑现 true）。
    assert.strictEqual(await worker.waitReady(8000), true, 'warmup 帧到达即兑现 true');
    assert.strictEqual(worker.isReady, true);
  } finally {
    delete process.env['FAKE_SCENARIO'];
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：加载帧永不回来时，加载预算到点即解卡（不得永久停在「加载中」）', async () => {
  // 2026-10-07 二轮评审判定的真回归：为了躲开「15s 请求预算卡住 24s 加载」而把 warmup 帧改成
  // **无超时**后，子进程「活着但永不回帧」会让 `loading` 永久为真（preload 永不重投）、`loadError`
  // 永久为空（每个 decide 都报「仍在加载」），并且在途帧 ref 住事件循环、连父进程都退不出去。
  // 本判据用 silent 场景（活着、永不回 warmup）把「必须有界」钉死。
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-silent-'));
  const worker = makeWorker(writeFakeWorker(root), { loadTimeoutMs: 300 });
  process.env['FAKE_SCENARIO'] = 'silent';
  try {
    worker.preload();
    assert.strictEqual(await worker.waitReady(600), false, '永不回帧 ⇒ 不会就绪');
    // 加载预算到点后必须解卡：loading 归假、原因如实记录、决策不再谎报「加载中」。
    const deadline = Date.now() + 2000;
    while (worker.isLoading && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.strictEqual(worker.isLoading, false, '加载超时后必须解卡（否则永久停在「加载中」）');
    assert.match(worker.lastLoadError, /超时/, '应记录真实原因（超时）');
    const response = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(response.available, false);
    assert.doesNotMatch(response.note ?? '', /仍在加载/, '不得继续谎报「仍在加载」');
  } finally {
    delete process.env['FAKE_SCENARIO'];
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：加载失败时如实报「不可用 + 真原因」，不谎报「仍在加载」', async () => {
  // 2026-10-07 评审发现：原先 preload 的失败被 `.catch(() => undefined)` 丢掉，于是 decide 一律回
  // 「仍在加载权重」——把「解释器/脚本坏了」误导成「稍等就好」，运维会对着一个永远不会好的故障等下去。
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-badpy-'));
  const worker = new LayaWarmWorker({
    pythonPath: join(root, 'definitely-missing-python'),
    scriptPath: join(root, 'whatever.py'),
    modelDir: '',
    repo: 'fake',
    hfEndpoint: 'http://127.0.0.1:1',
    warmupWaitMs: 1000,
    loadTimeoutMs: 10_000,
    requestTimeoutMs: 1000,
    idleShutdownMs: 600_000,
  });
  try {
    const response = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(response.available, false);
    assert.match(
      response.note ?? '',
      /不可用/,
      `应如实报不可用（实测 note=${response.note ?? ''}）`,
    );
    assert.doesNotMatch(response.note ?? '', /仍在加载/, '不得把真故障谎报成「仍在加载」');
    assert.strictEqual(worker.isLoading, false, '加载已经失败，不应仍被标记为「加载中」');
    assert.ok(worker.lastLoadError.length > 0, '应记住真实原因供诊断');
  } finally {
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('热进程：dispose 后不再启动（fail-open 且说明原因）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-warm-dispose-'));
  const worker = makeWorker(writeFakeWorker(root));
  try {
    assert.strictEqual((await worker.probe()).available, true);
    worker.dispose();
    const after = await worker.decide({
      state: 'a',
      questions: QUESTIONS,
      repo: 'fake',
      modelDir: '',
    });
    assert.strictEqual(after.available, false);
    assert.match(after.note ?? '', /关闭/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
