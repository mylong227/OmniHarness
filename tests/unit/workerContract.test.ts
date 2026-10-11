/**
 * `src/worker/worker.ts`（worker 契约）判据 —— 以及它**唯一可执行的语义**：取消下传。
 *
 * ## 先说清楚这个文件是什么（实测，不是推断）
 *
 * `worker.ts` 是**纯类型声明模块**：只有 `export interface WorkerRequest / WorkerResult / Worker`，
 * 没有任何运行时值，编译产物 `dist/src/worker/worker.js` 只有一行 `export {};`（45 字节）。
 * ⇒ 它的"行覆盖率"**恒无意义**：`node --experimental-test-coverage` 的报表里根本不列出这个文件
 * （没有可执行行可统计）。任何声称"把 worker.ts 覆盖率从 0 提到 N%"的说法都是假报告。
 *
 * 所以本文件不编造运行时覆盖率，而是锁三件**真的会坏**的事：
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 契约形状（`signal?: AbortSignal \| undefined` 等字段）源级断言 | 字段被删/改成必填 ⇒ 取消通道在类型层消失 |
 * | ② | 契约模块保持**纯类型**（dist 产物恒为 `export {};`） | 有人偷偷加运行时值 ⇒ "零执行行"的前提被打破而无人知 |
 * | ③ | 取消下传链 `DelegateTool → WorkerOrchestrator → Worker.run` 收到**同一个** AbortSignal | 父会话的信号被丢在某一层，子进程跑到 30 分钟超时 |
 * | ④ | 取消真的到达子进程（真 AbortController + 真子进程） | Ctrl-C 后 worker 仍跑、`delegate` 串行屏障永久阻塞 |
 * | ⑤ | 取消**不泄漏监听器**（正常收尾路径也必须摘除 abort 监听） | 长生命周期 session signal 每次委派 +1 监听器 |
 * | ⑥ | 异常路径：不存在的命令 ⇒ `ok:false` 且原因可读（不抛、不挂） | spawn 失败被当成功/静默 |
 * | ⑦ | 退出码语义：0 ⇒ `ok:true`（空输出也算成功）；非 0 ⇒ `ok:false` 带退出码 | 退出码语义漂移 ⇒ 下游误判成败 |
 *
 * 判据③的来源是 2026-10-01 审计的真实缺陷（见 `delegateTool.ts` 注释）：`WorkerRequest.signal`
 * 字段与 `CliWorker` 的 kill-tree 都齐了，但父会话 signal **从未被传进来**——字段存在 ≠ 链路通。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CliWorker } from '../../src/worker/cliWorker.js';
import { WorkerOrchestrator } from '../../src/worker/workerOrchestrator.js';
import { WorkerRegistry } from '../../src/worker/workerRegistry.js';
import { DelegateTool } from '../../src/adapters/tool/workflow/delegateTool.js';
import type { Worker, WorkerRequest, WorkerResult } from '../../src/worker/worker.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

/** 契约源文件路径（由测试文件位置解析，不依赖 cwd）。 */
const CONTRACT_SOURCE = fileURLToPath(new URL('../../../src/worker/worker.ts', import.meta.url));
/** 契约编译产物路径。 */
const CONTRACT_DIST = fileURLToPath(new URL('../../src/worker/worker.js', import.meta.url));

/** 去掉块注释（判据只看声明，避免把文档里的 `{@link X}` 当语法）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 取出 `export interface <name> { ... }` 的**body**（按大括号配平，嵌套安全）。
 * @param source 已去注释的源文本。
 * @param name 接口名。
 * @returns 接口 body；找不到返回空串。
 */
function interfaceBody(source: string, name: string): string {
  // `\b` 必须留着：`export interface Worker` 会前缀命中先声明的 `WorkerRequest`。
  const declaration = new RegExp(`export interface ${name}\\b`).exec(source);
  if (declaration === null) return '';
  const open = source.indexOf('{', declaration.index);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return '';
}

/**
 * 契约检查器（纯函数）：返回违规清单，空数组 = 合规。
 *
 * 之所以做成"返回清单"而不是直接 assert：这样能用**已知坏输入**（删掉 signal 行、去掉
 * `| undefined`、塞进运行时值…）证明它会红——判据本身可证伪，而不是"写完就恒绿"。
 * @param source worker 契约源文本。
 * @returns 违规描述数组。
 */
function contractViolations(source: string): string[] {
  const violations: string[] = [];
  const text = stripComments(source);

  const request = interfaceBody(text, 'WorkerRequest');
  if (request === '') {
    violations.push('WorkerRequest 接口不存在');
  } else {
    if (!/readonly task:\s*string/.test(request)) violations.push('WorkerRequest 缺 readonly task');
    if (!/readonly workspaceRoot:\s*string/.test(request)) {
      violations.push('WorkerRequest 缺 readonly workspaceRoot');
    }
    // 关键字段：可选（`?:`）且显式带 `| undefined`（exactOptionalPropertyTypes 下实现侧要能原样转交）。
    if (!/readonly signal\?:\s*AbortSignal/.test(request)) {
      violations.push('WorkerRequest 缺 signal?: AbortSignal（取消通道在类型层消失）');
    } else if (!/readonly signal\?:\s*AbortSignal\s*\|\s*undefined/.test(request)) {
      violations.push('signal 缺少 `| undefined`（exactOptionalPropertyTypes 下无法原样转交）');
    }
  }

  const result = interfaceBody(text, 'WorkerResult');
  if (result === '') {
    violations.push('WorkerResult 接口不存在');
  } else {
    for (const field of ['ok:\\s*boolean', 'output:\\s*string', 'durationMs:\\s*number']) {
      if (!new RegExp(`readonly ${field}`).test(result)) {
        violations.push(`WorkerResult 缺 readonly ${field.replace('\\s*', ' ')}`);
      }
    }
  }

  const worker = interfaceBody(text, 'Worker');
  if (worker === '') {
    violations.push('Worker 接口不存在');
  } else {
    if (!/readonly name:\s*string/.test(worker)) violations.push('Worker 缺 readonly name');
    if (!/run\(request:\s*WorkerRequest\):\s*Promise<WorkerResult>/.test(worker)) {
      violations.push('Worker 缺 run(request): Promise<WorkerResult>（插口形状漂移）');
    }
  }

  // 纯类型模块：不得出现任何运行时导出（否则"零可执行行"的前提不成立）。
  for (const match of text.matchAll(/^export\s+(?!interface\b|type\b)(\w+)/gm)) {
    violations.push(`契约模块混入运行时导出: export ${String(match[1])}`);
  }
  return violations;
}

/** 记录型 worker：把收到的 WorkerRequest 原样留证（不 spawn 任何东西）。 */
class RecordingWorker implements Worker {
  /** worker 名。 */
  public readonly name = 'recording';
  /** 收到的请求（留证用）。 */
  public readonly seen: WorkerRequest[] = [];

  /**
   * 记录请求并成功返回。
   * @param request 委派请求。
   * @returns 固定成功结果。
   */
  public async run(request: WorkerRequest): Promise<WorkerResult> {
    this.seen.push(request);
    return { ok: true, output: 'recorded', durationMs: 0 };
  }
}

/** 只睡不返回的子进程（用本进程的 node，无外部依赖、无网络）。 */
function sleeperWorker(timeoutMs: number): CliWorker {
  return new CliWorker({
    name: 'sleeper',
    command: process.execPath,
    args: () => ['-e', 'setTimeout(() => undefined, 60000)'],
    timeoutMs,
  });
}

/** 委派工具调用（worker 名 + 任务文本）。 */
function delegateCall(worker: string, task: string): ToolCall {
  return { id: 'c1', name: 'delegate', arguments: { worker, task } };
}

test('① 契约形状：WorkerRequest/WorkerResult/Worker 的字段与 signal 可选性必须齐备', () => {
  const source = readFileSync(CONTRACT_SOURCE, 'utf8');
  assert.deepStrictEqual(
    contractViolations(source),
    [],
    'worker 契约形状漂移（删字段 / 改必填 / 混入运行时值）',
  );
});

test('①-正对照：同一检查器在**已知坏输入**下必须报违规（判据可证伪，不是恒绿）', () => {
  const source = readFileSync(CONTRACT_SOURCE, 'utf8');

  // 历史缺陷形态（2026-09-26 审计 X3/F3）：WorkerRequest 连 signal 字段都没有。
  const noSignal = source.replace(/^\s*readonly signal\?:.*$/m, '');
  assert.notStrictEqual(noSignal, source, '坏输入构造失败（没删掉 signal 行）');
  const signalMissing = contractViolations(noSignal);
  assert.ok(
    signalMissing.some((violation) => violation.includes('缺 signal')),
    `删掉 signal 行必须报违规，实得：${signalMissing.join('; ') || '(空)'}`,
  );

  // `| undefined` 被去掉：exactOptionalPropertyTypes 下实现侧无法原样转交。
  const noUndefined = source.replace('AbortSignal | undefined', 'AbortSignal');
  assert.notStrictEqual(noUndefined, source, '坏输入构造失败（没改掉 | undefined）');
  assert.ok(
    contractViolations(noUndefined).some((violation) => violation.includes('| undefined')),
    '去掉 `| undefined` 必须报违规',
  );

  // 字段被删：退出码/耗时语义丢失。
  const noDuration = source.replace(/^\s*readonly durationMs: number;$/m, '');
  assert.ok(
    contractViolations(noDuration).some((violation) => violation.includes('durationMs')),
    '删掉 durationMs 必须报违规',
  );

  // 混入运行时值：契约模块不再是"零可执行行"。
  const runtimeValue = `${source}\nexport const WORKER_VERSION = 1;\n`;
  assert.ok(
    contractViolations(runtimeValue).some((violation) => violation.includes('运行时导出')),
    '混入运行时导出必须报违规',
  );

  // 正对照的另一半：合规输入必须零违规（检查器不是"一律报违规"）。
  assert.deepStrictEqual(contractViolations(source), []);
});

test('② 契约模块是纯类型模块：dist 产物恒为 `export {};`（"零执行行"是事实而非漏测）', () => {
  const compiled = readFileSync(CONTRACT_DIST, 'utf8');
  const statements = compiled
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//# sourceMappingURL'));
  assert.deepStrictEqual(
    statements,
    ['export {};'],
    '契约模块产出了可执行语句 ⇒ 应改判为"必须测"的运行时模块，而不是继续当纯类型',
  );
  // 与源码级判据一致：不得有运行时导出。
  assert.deepStrictEqual(contractViolations(readFileSync(CONTRACT_SOURCE, 'utf8')), []);
});

test('③ 取消下传链：DelegateTool → WorkerOrchestrator → Worker.run 必须收到**同一个** AbortSignal', async () => {
  const worker = new RecordingWorker();
  const registry = new WorkerRegistry();
  registry.register(worker);
  const tool = new DelegateTool(new WorkerOrchestrator(registry));

  const controller = new AbortController();
  const context: ToolContext = {
    sessionId: 's1',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
  };
  const result = await tool.handle(delegateCall('recording', '子任务'), context);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, '[recording] recorded', '委派结果须带 worker 名前缀');
  const carried = worker.seen[0]?.signal;
  assert.strictEqual(
    carried,
    controller.signal,
    'worker 必须收到**同一个** AbortSignal 实例（换实例/丢字段 = 父会话取消永远打不到子进程）',
  );
  assert.strictEqual(worker.seen[0]?.task, '子任务');
  assert.strictEqual(worker.seen[0]?.workspaceRoot, process.cwd());
});

test('③-正对照：坏委派形态（丢掉 signal）在同一判据下必须为红', async () => {
  const worker = new RecordingWorker();
  const controller = new AbortController();
  // 显式复现历史缺陷的实现形态：orchestrator 层 `run({ task, workspaceRoot })`（没有 signal）。
  const delegateWithoutSignal = async (
    task: { readonly task: string },
    workspaceRoot: string,
  ): Promise<WorkerResult> => await worker.run({ task: task.task, workspaceRoot });

  await delegateWithoutSignal({ task: '子任务' }, process.cwd());
  const carried = worker.seen[0]?.signal;
  assert.strictEqual(carried, undefined, '坏实现确实把 signal 丢了（复现现场）');
  assert.notStrictEqual(
    carried,
    controller.signal,
    '判据（实例相等）在坏实现上必须为红——所以它真的在测"下传"，不是恒真',
  );
});

test('④ 取消真的到达子进程：真 AbortController 中止 ⇒ 委派失败且原因可读、有界返回', async () => {
  const registry = new WorkerRegistry();
  registry.register(sleeperWorker(60_000));
  const tool = new DelegateTool(new WorkerOrchestrator(registry));

  const controller = new AbortController();
  const context: ToolContext = {
    sessionId: 's1',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
  };
  const started = Date.now();
  const running = tool.handle(delegateCall('sleeper', '长任务'), context);
  await new Promise((resolve) => setTimeout(resolve, 300)); // 等子进程真的起来
  controller.abort();
  const result = await running;
  const elapsed = Date.now() - started;

  assert.strictEqual(result.ok, false, '取消必须如实报失败');
  assert.match(String(result.error), /已被取消/, '原因必须可读（模型侧看 error）');
  assert.ok(elapsed < 20_000, `取消必须有界返回，实际 ${String(elapsed)}ms`);
});

test('⑤ 取消不泄漏监听器：正常收尾（成功 / 非零退出）后 session signal 上零残留', async () => {
  const controller = new AbortController();
  const running = new CliWorker({
    name: 'ok',
    command: process.execPath,
    args: () => ['-e', 'process.stdout.write("done")'],
  });
  const ok = await running.run({
    task: 't',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
  });
  assert.strictEqual(ok.ok, true, '退出码 0 必须算成功');
  assert.strictEqual(ok.output, 'done', '成功时输出必须原样带回');
  assert.strictEqual(
    getEventListeners(controller.signal, 'abort').length,
    0,
    '成功收尾后不得残留 abort 监听器（长生命周期信号每次委派 +1 ⇒ 泄漏）',
  );

  const failing = new CliWorker({
    name: 'bad',
    command: process.execPath,
    args: () => ['-e', 'process.exit(7)'],
  });
  const bad = await failing.run({
    task: 't',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
  });
  assert.strictEqual(bad.ok, false, '非 0 退出码必须算失败');
  assert.match(bad.output, /退出码 7/, '失败原因必须带退出码（下游据此分流）');
  assert.strictEqual(
    getEventListeners(controller.signal, 'abort').length,
    0,
    '失败收尾后同样不得残留监听器',
  );

  // 同一个信号跑两次都干净 ⇒ 判据不是"只清一次"。
  assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
});

test('⑥ 异常路径：命令不存在 ⇒ ok:false 且原因可读（不抛异常、不静默成功）', async () => {
  const worker = new CliWorker({
    name: 'ghost',
    command: 'definitely-not-a-real-binary-omniharness-xyz',
    args: () => [],
  });
  const result = await worker.run({ task: 't', workspaceRoot: process.cwd() });
  assert.strictEqual(result.ok, false, 'spawn 失败必须如实报失败（不得抛给调用方）');
  assert.match(
    result.output,
    /ENOENT|not found|找不到/i,
    `spawn 失败原因必须可读，实得：${result.output}`,
  );
  assert.ok(result.durationMs >= 0);
});

test('⑦ 退出码语义：0 ⇒ ok:true（空输出也算成功），非 0 ⇒ ok:false', async () => {
  const silent = new CliWorker({
    name: 'silent',
    command: process.execPath,
    args: () => ['-e', ''],
  });
  const okResult = await silent.run({ task: 't', workspaceRoot: process.cwd() });
  assert.strictEqual(okResult.ok, true, '退出码 0 且无输出仍算成功（空输出≠失败）');
  assert.strictEqual(okResult.output, '');

  const exit3 = new CliWorker({
    name: 'exit3',
    command: process.execPath,
    args: () => ['-e', 'process.exit(3)'],
  });
  const badResult = await exit3.run({ task: 't', workspaceRoot: process.cwd() });
  assert.strictEqual(badResult.ok, false);
  assert.match(badResult.output, /退出码 3/);
});

test('⑧ 批量委派也必须可取消：delegateAll 透传 signal（2026-10-11 补齐的缺口）', async () => {
  // 缺口：`delegateAll` 原先**没有** `signal` 形参、内部也不传 ⇒ 批量委派不可取消，
  // 而单条 `delegate` 的链路（DelegateTool → delegate → Worker.run）已验证可杀子进程。
  // 本判据用**同一条链路**的两种调用形态做对照：带信号 ⇒ 有界取消；不带信号 ⇒ 跑完。
  const registry = new WorkerRegistry();
  registry.register(sleeperWorker(60_000));
  const orchestrator = new WorkerOrchestrator(registry);
  const tasks = [
    { worker: 'sleeper', task: '批量长任务 A' },
    { worker: 'sleeper', task: '批量长任务 B' },
  ] as const;

  const controller = new AbortController();
  const started = Date.now();
  const running = orchestrator.delegateAll(tasks, process.cwd(), 1, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 300)); // 等子进程真的起来
  controller.abort();
  const results = await running;
  const elapsed = Date.now() - started;

  assert.strictEqual(results.length, tasks.length, '结果必须与任务清单同序同长');
  for (const [index, result] of results.entries()) {
    assert.strictEqual(result.ok, false, `第 ${String(index)} 条必须如实报失败（而不是跑满 60s）`);
  }
  assert.ok(elapsed < 20_000, `批量取消必须有界返回，实际 ${String(elapsed)}ms`);

  // **正面对照**：同一条链路、同样的任务，**不传**信号时按原样跑完 —— 证明上面的失败
  // 来自"信号被透传"这一事实，而不是批量路径本身的某种无条件失败。
  const shortRegistry = new WorkerRegistry();
  shortRegistry.register(
    new CliWorker({
      name: 'sleeper',
      command: process.execPath,
      args: () => ['-e', 'setTimeout(() => undefined, 100)'],
      timeoutMs: 20_000,
    }),
  );
  const completed = await new WorkerOrchestrator(shortRegistry).delegateAll(
    [{ worker: 'sleeper', task: '短任务' }],
    process.cwd(),
    1,
  );
  assert.strictEqual(completed.length, 1);
  assert.strictEqual(completed[0]?.ok, true, '不传信号时应正常跑完（对照）');
});
