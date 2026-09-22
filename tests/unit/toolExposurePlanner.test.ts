/**
 * 工具暴露规划器单测（`src/core/toolExposurePlanner.ts`）。
 *
 * 锁死三类不变量，缺任一条都可能造成**静默能力损伤**：
 *   ① **fail-safe**：无信号 / 无命中 ⇒ 全部可见（宁多给不少给）；
 *   ② **恒可见通道**：`tool_search` / `ask_user` / `spill_read` 与未登记工具永不被隐藏；
 *   ③ **完备性**：`visible ∪ deferred == 全部工具` 且两者不相交（不丢工具、不重不漏）。
 *
 * 另锁「默认关」契约：`modeFromEnv` 未显式设 `plan` 时恒为 `off`（零行为变更）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolExposurePlanner, type ToolCategory } from '../../src/core/toolExposurePlanner.js';

/** 精简类别表：两条类别 + 一个故意不登记的工具，便于断言边界。 */
const CATEGORIES: readonly ToolCategory[] = [
  {
    id: 'files',
    hint: '文件读写',
    keywords: ['file', 'read', '文件', '读'],
    tools: ['read_file', 'write_file'],
  },
  {
    id: 'exec',
    hint: '命令执行',
    keywords: ['test', 'run', '测试'],
    tools: ['shell', 'run_code'],
  },
];

/** 全部工具（`orphan_tool` 不在任何类别中 ⇒ 应恒可见）。 */
const TOOLS = ['read_file', 'write_file', 'shell', 'run_code', 'orphan_tool', 'tool_search'];

test('无信号（任务文本为空）⇒ 全部可见，零延迟', () => {
  const plan = ToolExposurePlanner.plan({ taskText: '', tools: TOOLS, categories: CATEGORIES });
  assert.deepEqual([...plan.visible], TOOLS);
  assert.deepEqual([...plan.deferred], []);
  assert.deepEqual([...plan.matchedCategories], []);
  assert.match(plan.reason, /fail-safe/);
});

test('无类别命中 ⇒ 全部可见（fail-safe，不少给）', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: '帮我看看这个仓库的整体结构',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.deepEqual([...plan.visible], TOOLS);
  assert.deepEqual([...plan.deferred], []);
});

test('命中单一类别 ⇒ 该类 + 未登记工具 + 恒可见通道保留，其余延迟', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: '跑一下测试',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.deepEqual([...plan.matchedCategories], ['exec']);
  // exec 的两个 + 未登记的 orphan_tool + 恒可见的 tool_search。
  assert.deepEqual([...plan.visible], ['shell', 'run_code', 'orphan_tool', 'tool_search']);
  assert.deepEqual([...plan.deferred], ['read_file', 'write_file']);
});

test('英文关键词按词边界：`test` 命中，`latest` 不命中', () => {
  const hit = ToolExposurePlanner.plan({
    taskText: 'run the test suite',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.ok(hit.matchedCategories.includes('exec'));

  const miss = ToolExposurePlanner.plan({
    taskText: 'show me the latest changes',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.ok(!miss.matchedCategories.includes('exec'));
});

test('中文关键词按子串命中（`\\b` 对 CJK 不可靠）', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: '读取这个文件并总结',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.deepEqual([...plan.matchedCategories], ['files']);
});

test('恒可见通道永不被隐藏（即便其类别未命中）', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: '跑一下测试',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  for (const name of ToolExposurePlanner.DEFAULT_ALWAYS_VISIBLE) {
    if (TOOLS.includes(name)) assert.ok(plan.visible.includes(name), `${name} 必须恒可见`);
  }
});

test('完备性：visible ∪ deferred == 全部，且两者不相交', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: '读取文件',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.strictEqual(plan.visible.length + plan.deferred.length, TOOLS.length);
  assert.deepEqual([...plan.visible, ...plan.deferred].sort(), [...TOOLS].sort());
  const overlap = plan.visible.filter((n) => plan.deferred.includes(n));
  assert.deepEqual(overlap, []);
});

test('确定性：同输入恒同输出', () => {
  const input = { taskText: 'run the test suite', tools: TOOLS, categories: CATEGORIES };
  assert.deepEqual(ToolExposurePlanner.plan(input), ToolExposurePlanner.plan(input));
});

test('无工具时短路，不抛错', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: 'run test',
    tools: [],
    categories: CATEGORIES,
  });
  assert.deepEqual([...plan.visible], []);
  assert.deepEqual([...plan.deferred], []);
});

test('类别里写了未注册的工具名 ⇒ 忽略，不抛错也不误伤', () => {
  const categories: readonly ToolCategory[] = [
    { id: 'x', hint: 'x', keywords: ['test'], tools: ['shell', '不存在的工具'] },
  ];
  const plan = ToolExposurePlanner.plan({ taskText: 'test', tools: TOOLS, categories });
  assert.ok(plan.visible.includes('shell'));
  // 未登记进任何类别的工具仍然恒可见。
  assert.ok(plan.visible.includes('orphan_tool'));
});

test('默认类别表覆盖真实工具名，且不产生重复归属', () => {
  const seen = new Set<string>();
  for (const category of ToolExposurePlanner.DEFAULT_CATEGORIES) {
    assert.ok(category.keywords.length > 0, `${category.id} 须有关键词`);
    assert.ok(category.tools.length > 0, `${category.id} 须有工具`);
    for (const name of category.tools) {
      assert.ok(!seen.has(name), `${name} 被多个类别归属（会掩盖归类错误）`);
      seen.add(name);
    }
  }
});

test('modeFromEnv：仅显式 plan 才生效，其余一律 off（默认关 ⇒ 零行为变更）', () => {
  assert.strictEqual(ToolExposurePlanner.modeFromEnv({}), 'off');
  assert.strictEqual(ToolExposurePlanner.modeFromEnv({ OMNI_TOOL_EXPOSURE: '' }), 'off');
  assert.strictEqual(ToolExposurePlanner.modeFromEnv({ OMNI_TOOL_EXPOSURE: 'off' }), 'off');
  assert.strictEqual(ToolExposurePlanner.modeFromEnv({ OMNI_TOOL_EXPOSURE: 'PLAN' }), 'plan');
  assert.strictEqual(ToolExposurePlanner.modeFromEnv({ OMNI_TOOL_EXPOSURE: ' plan ' }), 'plan');
  assert.strictEqual(ToolExposurePlanner.modeFromEnv({ OMNI_TOOL_EXPOSURE: 'yes' }), 'off');
});

/**
 * **优化前口径的朴素匹配器**（逐关键词 `new RegExp`）。
 *
 * 存在目的：作为差分基准，钉住「把同类 ASCII 关键词合并成单条交替正则、并按类别表缓存」
 * 这一优化**行为逐字不变**。性能数字随机器漂移，而这条等价性不会——故以差分测试（而非
 * 基准测试）作为回归护栏。
 *
 * @param normalized 已小写并 trim 的文本。
 * @param keyword 关键词。
 * @returns 命中为 true。
 */
const naiveHitsKeyword = (normalized: string, keyword: string): boolean => {
  const kw = keyword.trim().toLowerCase();
  if (kw === '' || normalized === '') return false;
  if (/^[a-z0-9][a-z0-9 _-]*$/.test(kw)) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(normalized);
  }
  return normalized.includes(kw);
};

/** 用朴素匹配器复算命中类别（口径同 plan()：按类别表顺序、任一关键词命中即算命中）。 */
const naiveMatched = (text: string): string[] => {
  const normalized = text.trim().toLowerCase();
  return ToolExposurePlanner.DEFAULT_CATEGORIES.filter((c) =>
    c.keywords.some((kw) => naiveHitsKeyword(normalized, kw)),
  ).map((c) => c.id);
};

/** 差分语料：含词边界陷阱、大小写、连字符、CJK 紧邻 ASCII、空串与纯符号。 */
const DIFF_CORPUS = [
  '修复 src/billing.test.ts 里失败的测试并跑一遍测试套件',
  'grep 一下哪里用到了 RepoMapPayload',
  '读取 docs/TASK_BOARD.md 并总结第 16 节',
  '抓取 https://example.com 的正文',
  '把这个页面的截图看一下渲染效果',
  '派两个子代理并行调研这两个目录',
  '回忆一下我上次说的偏好',
  '把仓库结构画成 mermaid 草图',
  '把计划写成待办清单',
  '看看这个仓库整体怎么样',
  'show me the latest changes', // `test` 不得命中 `latest`
  'run the test suite',
  'TEST RUN FILE WEB', // 大小写不敏感
  'file-test-reader', // 连字符边界
  'files',
  'filex', // 前缀不得命中
  'xfile', // 后缀不得命中
  'test123',
  '123test',
  '文件读 测试 计划', // CJK 子串
  '测试scheme', // CJK 紧邻 ASCII
  '',
  '   ',
  '!!!???', // 纯符号
  'www',
  'sketch policy checkpoint rollback spill',
  'memory recall remember history',
  'IMAGE screenshot BROWSER render',
];

test('优化回归：合并交替正则与朴素逐关键词匹配**逐条等价**（差分）', () => {
  for (const text of DIFF_CORPUS) {
    const planned = ToolExposurePlanner.plan({ taskText: text, tools: ['read_file'] });
    assert.deepEqual(
      [...planned.matchedCategories],
      naiveMatched(text),
      `语料 ${JSON.stringify(text)} 上，优化实现与朴素实现判定不一致`,
    );
  }
});
