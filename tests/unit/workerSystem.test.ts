import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliWorker } from '../../src/worker/cliWorker.ts';
import { SimpleWorker } from '../../src/worker/simpleWorker.ts';
import { WorkerRegistry } from '../../src/worker/workerRegistry.ts';
import { WorkerOrchestrator } from '../../src/worker/workerOrchestrator.ts';
import { DelegateTool } from '../../src/adapters/tool/workflow/delegateTool.ts';

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

test.skipIf(process.platform !== 'win32')(
  'CliWorker：npm .cmd 垫片解析成 node 入口，task 不经 cmd 的 %* 解析',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-worker-shim-'));
    try {
      const bin = join(dir, 'pkg', 'bin');
      mkdirSync(bin, { recursive: true });
      const entry = join(bin, 'cli.js');
      writeFileSync(entry, 'console.log(process.argv.slice(2).join("|"));\n', 'utf8');
      const shim = join(dir, 'demo.cmd');
      writeFileSync(
        shim,
        [
          '@ECHO OFF',
          'SETLOCAL',
          'SET "NODE_EXE=%~dp0\\node.exe"',
          'IF NOT EXIST "%NODE_EXE%" SET "NODE_EXE=node"',
          'SET "CLI_JS=%~dp0\\pkg\\bin\\cli.js"',
          '"%NODE_EXE%" "%CLI_JS%" %*',
        ].join('\r\n'),
        'utf8',
      );
      const worker = new CliWorker({
        name: 'shim-demo',
        command: shim,
        args: (task) => [task],
        shell: true,
      });
      const task = 'safe&echo INJECTED %PATH%';
      const result = await worker.run({ task, workspaceRoot: dir });
      assert.strictEqual(result.ok, true, result.output);
      assert.strictEqual(result.output.trim(), task, 'task 必须原样作为单个参数到达 JS 入口');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'CliWorker：Windows shell:true 不得把 task 里的 & 当命令分隔符（注入回归）',
  async () => {
    const worker = new CliWorker({
      name: 'inject-demo',
      command: process.execPath,
      args: (task) => ['-e', 'console.log(process.argv[1])', task],
      shell: true,
    });
    const task = 'safe&echo INJECTED %PATH%';
    const result = await worker.run({ task, workspaceRoot: process.cwd() });
    assert.strictEqual(result.ok, true, result.output);
    assert.strictEqual(result.output.trim(), task, 'task 必须原样作为单个参数到达子进程');
  },
);

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
