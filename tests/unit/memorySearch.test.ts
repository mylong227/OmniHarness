import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bm25MemoryIndex } from '../../src/adapters/retrieval/bm25MemoryIndex.js';
import { MemorySearchTool } from '../../src/adapters/tool/memorySearchTool.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { ConfigFactory } from '../../src/config/omniharnessConfig.js';
import { createRuntime } from '../../src/core/runtime.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { Agent } from '../../src/core/agent.js';
import type { RetrievalDoc, RetrievalHit, RetrievalPort } from '../../src/ports/retrieval.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool.js';

const ctx: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };

describe('Bm25MemoryIndex', () => {
  it('检索返回相关片段并按 session 过滤', () => {
    const idx = new Bm25MemoryIndex();
    idx.index({
      id: 'a1',
      sessionId: 's1',
      seq: 0,
      role: 'user',
      text: '数据库连接串是 postgres://...',
      ts: 't',
    });
    idx.index({
      id: 'a2',
      sessionId: 's1',
      seq: 1,
      role: 'assistant',
      text: '我们决定采用 Rust 内核',
      ts: 't',
    });
    idx.index({ id: 'b1', sessionId: 's2', seq: 0, role: 'user', text: '数据库密码忘了', ts: 't' });
    const hits = idx.search('数据库连接', 5);
    assert.ok(hits.length >= 1);
    const top = hits[0];
    assert.ok(top !== undefined);
    assert.strictEqual(top.doc.id, 'a1');
    const all = idx.search('数据库', 5);
    assert.ok(all.some((h) => h.doc.sessionId === 's1'));
    assert.ok(all.some((h) => h.doc.sessionId === 's2'));
    const onlyS2 = idx.search('数据库', 5, 's2');
    assert.ok(onlyS2.every((h) => h.doc.sessionId === 's2'));
    assert.strictEqual(onlyS2.length, 1);
    assert.strictEqual(idx.size, 3);
  });

  it('空查询 / 空索引安全返回空', () => {
    const idx = new Bm25MemoryIndex();
    assert.deepStrictEqual([...idx.search('x', 5)], []);
    idx.index({ id: 'a', sessionId: 's', seq: 0, role: 'user', text: 'hello world', ts: 't' });
    assert.deepStrictEqual([...idx.search('   ', 5)], []);
  });
});

describe('MemorySearchTool', () => {
  it('返回命中片段 JSON，空 query 报错', async () => {
    const idx = new Bm25MemoryIndex();
    idx.index({
      id: 'a1',
      sessionId: 's1',
      seq: 0,
      role: 'user',
      text: '密钥是 API_KEY=xyz123',
      ts: 't',
    });
    const tool = new MemorySearchTool(idx);
    const r = await tool.handle(
      { id: 'c', name: 'memory_search', arguments: { query: '密钥' } } as ToolCall,
      ctx,
    );
    assert.strictEqual(r.ok, true);
    const parsed = JSON.parse(r.output ?? '{}') as {
      count: number;
      results: Array<{ text: string; role: string }>;
    };
    assert.ok(parsed.count >= 1);
    const first = parsed.results[0];
    assert.ok(first !== undefined);
    assert.ok(first.text.includes('API_KEY=xyz123'));
    const bad = await tool.handle(
      { id: 'c', name: 'memory_search', arguments: { query: '  ' } } as ToolCall,
      ctx,
    );
    assert.strictEqual(bad.ok, false);
  });

  it('session 过滤透传给底层检索', async () => {
    const idx = new Bm25MemoryIndex();
    idx.index({ id: 'a1', sessionId: 's1', seq: 0, role: 'user', text: '数据库密钥', ts: 't' });
    idx.index({ id: 'a2', sessionId: 's2', seq: 0, role: 'user', text: '数据库密钥', ts: 't' });
    const tool = new MemorySearchTool(idx);
    const r = await tool.handle(
      { id: 'c', name: 'memory_search', arguments: { query: '数据库', session: 's1' } } as ToolCall,
      ctx,
    );
    assert.strictEqual(r.ok, true);
    const parsed = JSON.parse(r.output ?? '{}') as { results: Array<{ sessionId: string }> };
    assert.ok(parsed.results.every((x) => x.sessionId === 's1'));
    assert.strictEqual(parsed.results.length, 1);
  });
});

/** 探测型检索端口：记录被索引进的文档。 */
class SpyRetrieval implements RetrievalPort {
  public readonly name = 'spy';
  public docs: RetrievalDoc[] = [];

  public index(doc: RetrievalDoc): void {
    this.docs.push(doc);
  }

  public search(): readonly RetrievalHit[] {
    return [];
  }
}

describe('SessionRecorder 接入检索索引（#M2）', () => {
  it('仅索引 user/assistant/system/tool_result，跳过 reasoning/tool_call', () => {
    const spy = new SpyRetrieval();
    const rec = new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), 's1', spy);
    rec.user('我想读文件');
    rec.assistant('好的，请告诉我路径');
    rec.reasoning('我需要先确认路径');
    rec.system('上下文压缩点');
    rec.toolCall('c1', 'read_file', { path: '/x' });
    rec.toolResult('c1', true, '文件内容 here', undefined);
    const roles = spy.docs.map((d) => d.role);
    assert.ok(roles.includes('user'));
    assert.ok(roles.includes('assistant'));
    assert.ok(roles.includes('system'));
    assert.ok(roles.includes('tool'));
    // reasoning 不入索引：记录的 6 条事件中仅 4 条被索引（user/assistant/system/tool_result）。
    assert.strictEqual(spy.docs.length, 4, '应恰好 4 条：user/assistant/system/tool');
    const toolDoc = spy.docs.find((d) => d.role === 'tool');
    assert.ok(toolDoc !== undefined && toolDoc.text === '文件内容 here');
  });
});

/** 脚本化模型：按预设逐回合返回文本。 */
class ScriptedModel implements ModelPort {
  public readonly name = 'scripted';

  public constructor(private readonly script: Array<{ text?: string }>) {}

  private index = 0;

  public async generate(_request: ModelRequest): Promise<ModelOutput> {
    const step = this.script[this.index] ?? { text: 'done' };
    this.index += 1;
    return { text: step.text ?? 'done' };
  }
}

describe('memory_search 端到端（记录器→检索→工具）', () => {
  it('运行会话后 memory_search 能召回助手消息中的关键信息', async () => {
    const model = new ScriptedModel([
      { text: '我们的数据库密钥是 API_KEY=xyz123，请妥善保管' },
      { text: 'done' },
    ]);
    const config = ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 10,
      model,
      storage: new MemoryStorage(),
      events: new SilentEventPort(),
    });
    const agent = new Agent(createRuntime(config));
    const result = await agent.runTask('开始任务');
    assert.ok(result.finalText !== undefined, '会话应正常结束并返回文本');
    // 记录器已在运行中把助手消息索引进 config.retrieval；经 memory_search 工具应可召回密钥。
    const searchResult = await config.tools.execute(
      { id: 'm1', name: 'memory_search', arguments: { query: '密钥' } } as ToolCall,
      ctx,
    );
    assert.strictEqual(searchResult.ok, true);
    assert.ok((searchResult.output ?? '').includes('API_KEY=xyz123'), '应召回助手消息中的密钥');
  });
});
