import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bm25Index, tokenize } from '../../src/search/bm25Index.js';
import { ToolIndex } from '../../src/search/toolIndex.js';
import { ToolDiscovery } from '../../src/search/toolDiscovery.js';
import { ToolSearchTool } from '../../src/adapters/tool/toolSearchTool.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { StepRunner } from '../../src/core/stepRunner.js';
import { ToolGate } from '../../src/core/toolGate.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/ports/tool/tool.js';
import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolSpec,
} from '../../src/ports/model/model.js';

const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name,
  arguments: args,
});
const okHandler = async (c: ToolCall): Promise<ToolResult> => ({
  callId: c.id,
  ok: true,
  output: `ran ${c.name}`,
});
const def = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  parameters: { type: 'object', properties: {}, required: [] },
});

/** 脚本化模型：按预设逐回合返回工具调用或文本，并记录每回合收到的工具集。 */
class ScriptedModel implements ModelPort {
  public readonly name = 'scripted';
  public receivedTools: ModelToolSpec[][] = [];
  private index = 0;

  public constructor(private readonly script: Array<{ toolCalls?: ToolCall[]; text?: string }>) {}

  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.receivedTools.push([...request.tools]);
    const step = this.script[this.index] ?? { text: 'done' };
    this.index += 1;
    if (step.toolCalls !== undefined) {
      return { toolCalls: step.toolCalls };
    }
    return { text: step.text ?? 'done' };
  }
}

describe('tokenize', () => {
  it('中英混合：ASCII 词 + CJK 二元组', () => {
    const tokens = tokenize('读取文件 read_file');
    assert.ok(tokens.includes('read_file'), '应含原始蛇形词');
    assert.ok(tokens.includes('file'), '应含 ascii 词');
    assert.ok(tokens.includes('读取'), '应含 CJK 二元组 读取');
    assert.ok(tokens.includes('文件'), '应含 CJK 二元组 文件');
  });

  it('过滤单字符 ascii 噪声', () => {
    const tokens = tokenize('a the read');
    assert.ok(!tokens.includes('a'));
    assert.ok(tokens.includes('read'));
  });
});

describe('Bm25Index', () => {
  it('检索返回最相关文档（降序、截断）', () => {
    const index = new Bm25Index();
    index.addDocuments([
      tokenize('read file content from disk'),
      tokenize('write file content to disk'),
    ]);
    const hits = index.search(tokenize('read file'), 1);
    assert.strictEqual(hits.length, 1);
    const top = hits[0];
    assert.ok(top !== undefined);
    assert.strictEqual(top.id, 0);
  });

  it('空查询 / 空索引安全返回空', () => {
    const index = new Bm25Index();
    assert.deepStrictEqual([...index.search(tokenize('x'), 5)], []);
    index.addDocuments([tokenize('a b c')]);
    assert.deepStrictEqual([...index.search([], 5)], []);
  });
});

describe('ToolIndex', () => {
  const tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: '读取工作区内的文件内容',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: '向工作区写入文件',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'shell',
      description: '执行 shell 命令',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ];

  it('按自然语言命中正确工具（中英均可）', () => {
    const index = new ToolIndex(tools);
    const read = index.search('如何读取文件', 3);
    assert.ok(read.length >= 1);
    const readTop = read[0];
    assert.ok(readTop !== undefined);
    assert.strictEqual(readTop.name, 'read_file');
    const write = index.search('write file content', 3);
    const writeTop = write[0];
    assert.ok(writeTop !== undefined);
    assert.strictEqual(writeTop.name, 'write_file');
  });

  it('空查询返回空', () => {
    assert.deepStrictEqual(new ToolIndex(tools).search('   ', 5), []);
  });

  it('reindex 后反映新工具集', () => {
    const index = new ToolIndex(tools);
    index.reindex([
      {
        name: 'web_search',
        description: '网络检索',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ]);
    const hits = index.search('网络检索', 3);
    const reindexTop = hits[0];
    assert.ok(reindexTop !== undefined);
    assert.strictEqual(reindexTop.name, 'web_search');
  });
});

describe('ToolSearchTool', () => {
  const buildRegistry = (): RegistryToolPort => {
    const registry = new RegistryToolPort();
    registry.register(def('read_file', '读取文件'), okHandler);
    registry.register(def('shell', '执行命令'), okHandler);
    return registry;
  };

  it('返回命中 schema 并登记 discovery', async () => {
    const registry = buildRegistry();
    const discovery = new ToolDiscovery();
    const tool = new ToolSearchTool(new ToolIndex(registry.list()), discovery);
    const r = await tool.handle(call('tool_search', { query: '读取文件', limit: 2 }), ctx);
    assert.strictEqual(r.ok, true);
    const parsed = JSON.parse(r.output ?? '{}') as {
      count: number;
      tools: Array<{ name: string }>;
    };
    assert.ok(parsed.count >= 1);
    const tool0 = parsed.tools[0];
    assert.ok(tool0 !== undefined);
    assert.strictEqual(tool0.name, 'read_file');
    assert.strictEqual(discovery.has('read_file'), true, '命中应登记进 discovery');
  });

  it('空 query 报错', async () => {
    const tool = new ToolSearchTool(new ToolIndex([]), new ToolDiscovery());
    const r = await tool.handle(call('tool_search', { query: '   ' }), ctx);
    assert.strictEqual(r.ok, false);
  });
});

describe('RegistryToolPort 延迟加载', () => {
  it('markDeferred + listDirect 隔离延迟工具，list 仍含全部', () => {
    const registry = new RegistryToolPort();
    registry.register(def('alpha', 'a'), okHandler);
    registry.register(def('beta', 'b'), okHandler);
    assert.strictEqual(registry.list().length, 2);
    assert.strictEqual(registry.listDirect().length, 2);
    registry.markDeferred(['beta']);
    assert.strictEqual(registry.listDirect().length, 1, 'listDirect 剔除 deferred');
    const direct0 = registry.listDirect()[0];
    assert.ok(direct0 !== undefined);
    assert.strictEqual(direct0.name, 'alpha');
    assert.strictEqual(registry.list().length, 2, 'list() 仍含全部（含可被执行的 deferred）');
  });

  it('未知名 markDeferred 静默忽略', () => {
    const registry = new RegistryToolPort();
    registry.register(def('alpha', 'a'), okHandler);
    registry.markDeferred(['ghost']);
    assert.strictEqual(registry.listDirect().length, 1);
  });
});

describe('StepRunner 延迟加载闭环（#M1 端到端）', () => {
  it('tool_search 发现后，延迟工具后续回合对模型可见且可被调用', async () => {
    const registry = new RegistryToolPort();
    registry.register(def('alpha', 'alpha 工具'), okHandler);
    registry.register(def('beta', 'beta 工具'), okHandler);
    const discovery = new ToolDiscovery();
    const searcher = new ToolSearchTool(new ToolIndex(registry.list()), discovery);
    registry.register(searcher.definition, (c, x) => searcher.handle(c, x));
    registry.markDeferred(['beta']); // beta 默认不进上下文

    const recorder = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 's1');
    recorder.user('start');
    const model = new ScriptedModel([
      { toolCalls: [call('tool_search', { query: 'beta 工具' })] },
      { toolCalls: [call('beta', {})] },
      { text: 'done' },
    ]);
    const step = new StepRunner({
      model,
      tools: registry,
      approvals: new AutoApproval(),
      sandbox: new PassthroughSandbox(),
      repoMapContext: new RepoMapContextEngine(),
      recorder,
      sessionId: 's1',
      gate: new ToolGate(new AutoApproval(), new PassthroughSandbox()),
      discovery,
    });

    const r1 = await step.run(ctx);
    assert.strictEqual(r1, 'tool');
    assert.strictEqual(discovery.has('beta'), true, 'tool_search 应登记 beta');

    const r2 = await step.run(ctx);
    assert.strictEqual(r2, 'tool');

    const r3 = await step.run(ctx);
    assert.strictEqual(r3, 'text');

    const first = model.receivedTools[0];
    assert.ok(first !== undefined, '应记录首回合工具集');
    const names0 = first.map((t) => t.name);
    assert.ok(!names0.includes('beta'), '首回合不应含延迟加载的 beta');
    assert.ok(names0.includes('alpha') && names0.includes('tool_search'));

    const second = model.receivedTools[1];
    assert.ok(second !== undefined, '应记录次回合工具集');
    assert.ok(second.map((t) => t.name).includes('beta'), '发现后次回合应含 beta');
  });
});
