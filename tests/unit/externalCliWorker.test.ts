import { test } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ExternalCliWorker } from '../../src/worker/externalCliWorker.ts';
import { WorkerRegistry } from '../../src/worker/workerRegistry.ts';
import { WorkerOrchestrator } from '../../src/worker/workerOrchestrator.ts';

/** 夹具：回显 argv 的 Node 脚本。 */
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'echoTask.mjs');

test('解析：NAME=COMMAND 与固定前置参数', () => {
  const spec = ExternalCliWorker.parse('c=claude -p');
  assert.deepStrictEqual(spec, { name: 'c', command: 'claude', args: ['-p'] });
  const noArgs = ExternalCliWorker.parse('plain=opencode');
  assert.deepStrictEqual(noArgs, { name: 'plain', command: 'opencode', args: [] });
});

test('解析：带引号与 Windows 路径不被反斜杠吞掉', () => {
  const spec = ExternalCliWorker.parse(String.raw`win="C:\Program Files\app.exe" --flag "a b"`);
  assert.strictEqual(spec.command, String.raw`C:\Program Files\app.exe`);
  assert.deepStrictEqual(spec.args, ['--flag', 'a b']);
});

test('解析：非法规格 fail-closed', () => {
  assert.throws(() => ExternalCliWorker.parse('no-equals'));
  assert.throws(() => ExternalCliWorker.parse('=cmd'));
  assert.throws(() => ExternalCliWorker.parse('bad name=cmd'));
  assert.throws(() => ExternalCliWorker.parse('x='));
  assert.throws(() => ExternalCliWorker.parse('x="unterminated'));
});

test('构造：注册名带 external: 前缀，且任务作为最后一个 argv 追加', async () => {
  const spec = ExternalCliWorker.parse(`echo="${process.execPath}" "${FIXTURE}"`);
  const worker = ExternalCliWorker.create(spec);
  assert.strictEqual(worker.name, 'external:echo');
  const result = await worker.run({ task: 'hello world', workspaceRoot: process.cwd() });
  assert.strictEqual(result.ok, true, result.output);
  assert.deepStrictEqual(JSON.parse(result.output ?? '[]'), ['hello world']);
});

test('编排：一次委派走注册表与 orchestrator', async () => {
  const registry = new WorkerRegistry();
  registry.register(
    ExternalCliWorker.create(ExternalCliWorker.parse(`echo="${process.execPath}" "${FIXTURE}"`)),
  );
  const orchestrator = new WorkerOrchestrator(registry);
  const result = await orchestrator.delegate(
    { worker: 'external:echo', task: '编排任务' },
    process.cwd(),
  );
  assert.strictEqual(result.ok, true, result.output);
  assert.deepStrictEqual(JSON.parse(result.output ?? '[]'), ['编排任务']);
});

test('注册表：同名 worker 重复注册即抛错', () => {
  const registry = new WorkerRegistry();
  const spec = ExternalCliWorker.parse('dup=cmd');
  registry.register(ExternalCliWorker.create(spec));
  assert.throws(() => registry.register(ExternalCliWorker.create(spec)), /重复注册/u);
});
