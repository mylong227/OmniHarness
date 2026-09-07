import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeGenerator } from '../../src/schema/codeGenerator.js';
import { protocolSchema } from '../../src/schema/protocolSchema.js';

test('schema：方法集完整（6 个原语）', () => {
  assert.strictEqual(protocolSchema.methods.length, 6);
  const names = protocolSchema.methods.map((method) => method.name);
  assert.ok(names.includes('threads.create'));
  assert.ok(names.includes('turns.run'));
  assert.ok(names.includes('approval.respond'));
});

test('TS 生成：包含全部方法与请求方法名', () => {
  const ts = new CodeGenerator().generateTs(protocolSchema);
  assert.match(ts, /class OmniHarnessClient/);
  assert.match(ts, /threadsCreate\(prompt: string/);
  assert.match(ts, /threadsContinue\(threadId: string, prompt: string/);
  assert.match(ts, /turnsRun\(/);
  assert.match(ts, /approvalRespond\(requestId: string, decision: string/);
  assert.match(ts, /'threads\.create'/);
  assert.match(ts, /'turns\.run'/);
});

test('TS 生成：方法数量 = 普通方法 + 流式方法', () => {
  const ts = new CodeGenerator().generateTs(protocolSchema);
  const count = (ts.match(/return this\.call\(/g) ?? []).length;
  const streamCount = protocolSchema.methods.filter((method) => method.stream !== undefined).length;
  assert.strictEqual(count, protocolSchema.methods.length + streamCount);
});

test('Python 生成：蛇形方法与请求体', () => {
  const py = new CodeGenerator().generatePython(protocolSchema);
  assert.match(py, /class OmniHarnessClient/);
  assert.match(py, /def threads_create\(prompt: str/);
  assert.match(py, /def turns_run\(/);
  assert.match(py, /def approval_respond\(request_id: str, decision: str/);
  assert.match(py, /'threads\.create', \{'prompt': prompt\}/);
  assert.match(py, /'approval\.respond', \{'requestId': request_id, 'decision': decision\}/);
});

test('Python 生成：方法数量 = 普通方法 + 流式方法', () => {
  const py = new CodeGenerator().generatePython(protocolSchema);
  const count = (py.match(/return self\._call\(/g) ?? []).length;
  const streamCount = protocolSchema.methods.filter((method) => method.stream !== undefined).length;
  assert.strictEqual(count, protocolSchema.methods.length + streamCount);
});

test('协议文档：包含方法表与字段详情', () => {
  const docs = new CodeGenerator().generateDocs(protocolSchema);
  assert.match(docs, /# OmniHarness 协议文档/);
  assert.match(docs, /## 方法一览/);
  assert.match(docs, /\| `threads\.create` \| 创建线程并执行任务 \|/);
  assert.match(docs, /### threads\.create/);
  assert.match(docs, /\| `prompt` \| string \| 是 \| 任务提示词 \|/);
  assert.match(docs, /\| `threadId` \| string \| 否 \| 线程 ID \|/);
});
