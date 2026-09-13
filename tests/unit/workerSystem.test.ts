import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliWorker } from '../../src/worker/cliWorker.js';
import { SimpleWorker } from '../../src/worker/simpleWorker.js';
import { WorkerRegistry } from '../../src/worker/workerRegistry.js';
import { WorkerOrchestrator } from '../../src/worker/workerOrchestrator.js';
import { DelegateTool } from '../../src/adapters/tool/workflow/delegateTool.js';

/** 测试上下文。 */
const context = { sessionId: 's1', workspaceRoot: process.cwd() };

test('CliWorker：spawn 真实进程并收集输出', async () => {
  const worker = new CliWorker({
    name: 'node-demo',
    command: process.execPath,
    args: () => ['-e', "console.log('worker-out')"],
  });
  const result = await worker.run({ task: 't', workspaceRoot: process.cwd() });
  assert.strictEqual(result.ok, true);
  assert.match(result.output, /worker-out/);
  assert.ok(result.durationMs >= 0);
});

test('CliWorker：失败命令返回失败结果', async () => {
  const worker = new CliWorker({
    name: 'fail-demo',
    command: process.execPath,
    args: () => ['-e', 'process.exit(3)'],
  });
  const result = await worker.run({ task: 't', workspaceRoot: process.cwd() });
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /退出码 3/);
});

test('WorkerRegistry：注册与选择', () => {
  const registry = new WorkerRegistry();
  registry.register(new SimpleWorker('a'));
  assert.strictEqual(registry.get('a').name, 'a');
  assert.throws(() => registry.get('nope'), /未知 worker/);
  assert.throws(() => registry.register(new SimpleWorker('a')), /重复注册/);
});

test('Orchestrator：一次任务调度多个 worker（≥2 种）', async () => {
  const registry = new WorkerRegistry();
  registry.register(new SimpleWorker('harness-a', 'A 完成'));
  registry.register(new SimpleWorker('harness-b', 'B 完成'));
  const orchestrator = new WorkerOrchestrator(registry);

  const results = await orchestrator.delegateAll(
    [
      { worker: 'harness-a', task: '子任务一' },
      { worker: 'harness-b', task: '子任务二' },
    ],
    process.cwd(),
  );
  assert.strictEqual(results.length, 2);
  assert.match(results[0]?.output ?? '', /A 完成/);
  assert.match(results[1]?.output ?? '', /B 完成/);
  assert.strictEqual(registry.names().length, 2);
});

test('DelegateTool：委派成功并带 worker 名', async () => {
  const registry = new WorkerRegistry();
  registry.register(new SimpleWorker('demo-x', 'X 输出'));
  const tool = new DelegateTool(new WorkerOrchestrator(registry));
  const result = await tool.handle(
    { id: 'c1', name: 'delegate', arguments: { worker: 'demo-x', task: '做点事' } },
    context,
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, '[demo-x] X 输出');
});

test('DelegateTool：未知 worker 返回失败', async () => {
  const registry = new WorkerRegistry();
  const tool = new DelegateTool(new WorkerOrchestrator(registry));
  const result = await tool.handle(
    { id: 'c1', name: 'delegate', arguments: { worker: 'ghost', task: 'x' } },
    context,
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /未知 worker/);
});
