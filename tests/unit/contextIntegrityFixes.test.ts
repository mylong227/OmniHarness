/**
 * 探针：上下文子系统的三处「声称 vs 实现」不一致（各自独立，均先红后绿）。
 *
 * ① `SemanticIndexCache.clear(root)` —— 声称「按 root 失效须清掉该 root 下全部变体」，
 *    实际按**第一个** `|` 切分键（真实键形如 `chunk|snip600|<root>`，有两个 `|`），
 *    比较串恒为 `<rep>|<root>` ⇒ 与 root 永不相等 ⇒ **整个方法实为空操作**。
 *    后果：语料失效/清空后同一 root 的**陈旧向量索引**仍被命中（`get` 的键只含
 *    chunk/rep/root，无法感知语料已换），静默脏读。
 * ② `ToolResultSpiller.replace` —— 声称「用替代文本替换原输出（保持另一字段原样）」，
 *    实际无条件替换 `output` 并把 `error` 整个丢掉。失败结果（shell 超限时
 *    `output` + `error` 双字段）经 `ContextAssembler.toolContentOf` 只渲染 `error`
 *    ⇒ 模型看到「工具执行失败: 未知错误」，既丢原因也拿不到 `spill://` 读回句柄。
 * ③ `DeterministicCompressor` 类注释声称「三大定律（配机械测试）：
 *    1. 幂等 compress ∘ compress ≡ compress 2. 单调 bytes(compress(x)) ≤ bytes(x)」，
 *    且 `CompressReport.ratio` 声称「∈ (0,1]」。当 `headLines/tailLines` 之和 ≥ `maxLines`
 *    （合法选项组合，如 `{maxLines: 10}` 而 head/tail 取默认 40）时，截断**保留全部行**
 *    并追加省略标记 ⇒ 文本逐轮变长、幂等与单调同时失效、ratio > 1。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticIndexCache } from '../../src/context/semanticIndexCache.js';
import { RecallKnobs } from '../../src/context/recallKnobs.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { DeterministicCompressor } from '../../src/context/deterministicCompressor.js';
import { ContextCompactor, COMPACTION_MARKER } from '../../src/context/contextCompactor.js';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.js';
import type { StepRunnerDeps } from '../../src/core/stepTypes.js';
import type { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
import type { ModelMessage, ModelPort } from '../../src/ports/model/model.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { SpillHandle, SpillPort } from '../../src/ports/memory/spill.js';

/**
 * 取私有缓存表（探针需要直接观察键留存，生产代码无公开迭代口）。
 * @param cache 语义索引缓存实例。
 * @returns 内部 Map 的同一引用。
 */
const cacheOf = (cache: SemanticIndexCache): Map<string, unknown> =>
  (cache as unknown as { cache: Map<string, unknown> }).cache;

/** 假外溢端口（内存实现，零 IO）。 */
class FakeSpill implements SpillPort {
  /** 端口名（端口契约要求）。 */
  public readonly name = 'fake-spill';

  /** 已外溢内容（id → 文本）。 */
  private readonly store = new Map<string, string>();

  /**
   * 保存内容并返回句柄。
   * @param content 待外溢的完整内容。
   * @param _sessionId 会话 id（本替身忽略）。
   * @returns 句柄（id 递增）。
   */
  public async spill(content: string, _sessionId: string): Promise<SpillHandle> {
    const id = `spill_${this.store.size + 1}`;
    this.store.set(id, content);
    return { id, bytes: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * 读回内容。
   * @param id 外溢 id。
   * @returns 完整内容；不存在时 undefined。
   */
  public async read(id: string): Promise<string | undefined> {
    return this.store.get(id);
  }
}

test('① SemanticIndexCache.clear(root) 必须清掉该 root 的全部配置变体（曾为空操作）', () => {
  const cache = new SemanticIndexCache();
  const root = 'D:\\ws\\proj';
  const keys = cacheOf(cache);
  // 复刻 production 键形（cacheKey 私有的唯一编码：`<chunk|nochunk>|<rep>|<root>`）。
  const knobs = [
    new RecallKnobs({ chunkRecall: true, docMode: 'snip' }),
    new RecallKnobs({ chunkRecall: false, docMode: 'id' }),
  ];
  const built = knobs.map((k) => {
    const rep = k.fullFileDoc ? 'fulldoc' : k.docMode === 'id' ? 'id' : 'snip600';
    return `${k.chunkRecall ? 'chunk' : 'nochunk'}|${rep}|${root}`;
  });
  for (const key of built) {
    keys.set(key, Promise.resolve(null));
  }
  keys.set('nochunk|fulldoc|D:\\ws\\other', Promise.resolve(null));

  cache.clear(root);

  for (const key of built) {
    assert.ok(!keys.has(key), `clear(${root}) 后仍残留该 root 的变体：${key}`);
  }
  assert.ok(keys.has('nochunk|fulldoc|D:\\ws\\other'), '不得误伤其它 root 的条目');
});

test('① 反向：clear() 无参仍清空全部（既有语义不回退）', () => {
  const cache = new SemanticIndexCache();
  const keys = cacheOf(cache);
  keys.set('chunk|id|A', Promise.resolve(null));
  keys.set('nochunk|id|B', Promise.resolve(null));
  cache.clear();
  assert.strictEqual(keys.size, 0);
});

test('② 失败结果外溢后，error（模型唯一会读的字段）必须保留失败原因与读回句柄', async () => {
  const spiller = new ToolResultSpiller(new FakeSpill(), {
    maxInlineBytes: 100,
    previewBytes: 20,
  });
  const stored = await spiller.apply(
    'shell',
    { callId: 'c1', ok: false, output: 'X'.repeat(500), error: '输出超出上限，已终止命令' },
    's1',
  );
  assert.strictEqual(stored.ok, false);
  assert.ok(stored.error !== undefined, 'error 不得被丢弃（ContextAssembler 只用 error 渲染失败）');
  assert.match(stored.error!, /spill_read/, '失败原因里必须带读回指引，否则全文永远取不回');
  assert.strictEqual(stored.output, 'X'.repeat(500), '另一字段（output）应原样保留');
});

test('② 反向：成功结果外溢仍替换 output（既有语义不回退）', async () => {
  const spiller = new ToolResultSpiller(new FakeSpill(), {
    maxInlineBytes: 100,
    previewBytes: 20,
  });
  const stored = await spiller.apply(
    'shell',
    { callId: 'c1', ok: true, output: 'Y'.repeat(500) },
    's1',
  );
  assert.strictEqual(stored.ok, true);
  assert.match(String(stored.output), /spill_read/);
  assert.ok(String(stored.output).length < 500, '超长输出应被预览替换');
});

test('③ compress 在 headLines/tailLines ≥ maxLines 时仍满足幂等 / 单调 / ratio ≤ 1', () => {
  const compressor = new DeterministicCompressor();
  const text = Array.from({ length: 15 }, (_, i) => `line${i}`).join('\n');
  const options = { maxLines: 10 };
  const first = compressor.compress([{ key: 't', kind: 'tool-result', text }], options);
  const second = compressor.compress(first.segments, options);
  const third = compressor.compress(second.segments, options);

  assert.deepStrictEqual(second.segments, first.segments, 'compress 必须幂等（第二遍不得再变）');
  assert.deepStrictEqual(third.segments, first.segments, '第三遍亦不得变（稳定点）');
  assert.ok(
    first.report.compressedBytes <= first.report.originalBytes,
    `单调律：压缩后字节（${first.report.compressedBytes}）不得大于压缩前（${first.report.originalBytes}）`,
  );
  assert.ok(first.report.ratio <= 1, `ratio 声称 ∈ (0,1]，实际 ${first.report.ratio}`);
  assert.ok(
    first.segments[0]!.text.split('\n').length <= options.maxLines,
    `截断后行数应 ≤ maxLines（实际 ${first.segments[0]!.text.split('\n').length}）`,
  );
});

test('③ 反向：默认参数下的截断仍保留头尾并标注省略行数（既有语义不回退）', () => {
  const compressor = new DeterministicCompressor();
  const text = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
  const out = compressor.compress([{ key: 't', kind: 'tool-result', text }]);
  const lines = out.segments[0]!.text.split('\n');
  assert.ok(lines.length <= 200, `默认 maxLines=200，实际 ${lines.length}`);
  assert.match(String(lines[40]), /lines omitted of 500/);
});

/**
 * 构造只跑「事件投影 + 压缩」的最小 StepContextBuilder 依赖（不碰 repo-map / 常驻指令）。
 * @param events 事件数组（就地增长，供 recorder.system 追加压缩游标）。
 * @returns 可喂给 StepContextBuilder 的依赖契约。
 */
const makeBuilderDeps = (events: SessionEvent[]): StepRunnerDeps =>
  ({
    model: {} as ModelPort,
    tools: { list: () => [] } as unknown as ToolPort,
    approvals: {},
    sandbox: {},
    sessionId: 's',
    compactor: new ContextCompactor(undefined, { maxTokens: 100, keepRecent: 2 }),
    fragments: [],
    repoMapEnabled: false,
    projectInstructionsEnabled: false,
    repoMapContext: {} as RepoMapContextEngine,
    recorder: {
      allEvents: () => events,
      system: (content: string) => {
        events.push({
          id: `sys_${events.length}`,
          type: 'system',
          sessionId: 's',
          timestamp: new Date().toISOString(),
          payload: { content },
        } as SessionEvent);
      },
    },
  }) as unknown as StepRunnerDeps;

test('④ 压缩游标只在变化时写回、且绝不进模型上下文（摘要副本恒 1 份）', async () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      id: `u${i}`,
      type: 'user',
      sessionId: 's',
      timestamp: new Date().toISOString(),
      payload: { content: `u${i} ${'x'.repeat(200)}` },
    } as SessionEvent);
  }
  const builder = new StepContextBuilder(makeBuilderDeps(events));
  const sent: ModelMessage[][] = [];
  for (let step = 0; step < 4; step++) {
    sent.push([...(await builder.buildMessages())]);
  }
  const last = sent[sent.length - 1]!;
  const summaryCopies = last.filter(
    (message) => message.role === 'system' && message.content.includes('[历史已省略]'),
  ).length;
  const markerLeaks = last.filter(
    (message) => message.role === 'system' && message.content.startsWith(COMPACTION_MARKER),
  ).length;
  assert.strictEqual(summaryCopies, 1, `摘要副本应恒为 1 份（实际 ${summaryCopies}）`);
  assert.strictEqual(markerLeaks, 0, `内部游标标记不得进模型上下文（实际 ${markerLeaks} 条）`);
  // 增长有界：第 3、4 步的请求体长度必须一致（此前每步 +1 条摘要 +1 条游标）。
  assert.strictEqual(
    sent[3]!.length,
    sent[2]!.length,
    `请求体长度不应随步数增长（step3=${sent[2]!.length} step4=${sent[3]!.length}）`,
  );
  // 崩溃恢复依赖游标事件仍在**事件日志**里（只是不投影）。
  assert.ok(
    events.some(
      (event) =>
        event.type === 'system' &&
        String((event.payload as { content?: string }).content).startsWith(COMPACTION_MARKER),
    ),
    '压缩游标事件必须仍落事件日志（restoreCompactionState 依赖它）',
  );
});

test('④ 反向：游标事件确实被 ContextAssembler 之外的消费方保留（日志有、投影无）', async () => {
  const events: SessionEvent[] = [
    {
      id: 'sys_1',
      type: 'system',
      sessionId: 's',
      timestamp: new Date().toISOString(),
      payload: { content: `${COMPACTION_MARKER} upTo=1 hash=ab\n摘要正文` },
    },
    {
      id: 'sys_2',
      type: 'system',
      sessionId: 's',
      timestamp: new Date().toISOString(),
      payload: { content: '普通系统说明' },
    },
  ];
  const builder = new StepContextBuilder(makeBuilderDeps(events));
  const messages = await builder.buildMessages();
  assert.ok(
    messages.some((message) => message.content === '普通系统说明'),
    '普通 system 事件照常投影',
  );
  assert.ok(
    !messages.some((message) => message.content.startsWith(COMPACTION_MARKER)),
    '压缩游标不得投影',
  );
});
