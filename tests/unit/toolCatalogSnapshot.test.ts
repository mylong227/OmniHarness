/**
 * (D4) 工具发现结果的**目录快照绑定**单测。
 *
 * 缺陷形态：`ToolDiscovery` 只是按名累积的寄存器（`search/toolDiscovery.ts` 一个裸 Map），
 * 而 `effectiveTools()` 原先**无条件**把已发现工具并入上下文。于是工具在会话中途被卸载
 * （`RegistryToolPort.unregister`，插件热卸载路径）后，寄存器里的**陈旧 schema 仍会进模型上下文**
 * ——模型据此发起调用，必然命中一个已不存在的工具。
 *
 * 修法：以**当前目录为准**——目录里没有的丢弃；仍在的取目录中的**最新定义**（不用陈旧副本）。
 * 本测试锁死这两条，防止回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.js';
import type { StepRunnerDeps } from '../../src/core/stepTypes.js';
import type { ToolDefinition } from '../../src/ports/tool/tool.js';
import type { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.js';
import type { SessionEvent } from '../../src/ports/runtime/event/sessionEvent.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';

/** 造一个工具定义（描述用于区分「目录里的新定义」与「寄存器里的陈旧副本」）。 */
const def = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
});

/** 造一条 user 事件（`exposeByRelevance` 的任务文本来源即这类事件）。 */
const userEvent = (content: string): SessionEvent => ({
  id: `e-${content}`,
  type: 'user',
  sessionId: 's1',
  timestamp: new Date(0).toISOString(),
  payload: { content },
});

/**
 * 构造最小依赖（只用到 `tools` / `discovery` / `recorder` 三处）。
 * @param catalog 当前工具目录（`list`）。
 * @param direct 直载工具（`listDirect`）。
 * @param discovered 发现寄存器内容。
 * @returns 可喂给 StepContextBuilder 的依赖契约。
 */
const makeDeps = (
  catalog: readonly ToolDefinition[],
  direct: readonly ToolDefinition[],
  discovered: readonly ToolDefinition[],
): StepRunnerDeps =>
  ({
    tools: { list: () => catalog, listDirect: () => direct },
    discovery: { list: () => discovered },
    recorder: { allEvents: () => [] },
    repoMapContext: {} as RepoMapContextEngine,
    fragments: [],
  }) as unknown as StepRunnerDeps;

const namesOf = (deps: StepRunnerDeps): string[] =>
  new StepContextBuilder(deps).effectiveTools().map((t) => t.name);

test('D4：已从目录移除的发现项**不得**再进上下文（插件卸载后的陈旧 schema）', () => {
  const names = namesOf(
    makeDeps(
      [def('alpha', 'a')], // 目录里只剩 alpha（beta 已卸载）
      [def('alpha', 'a')],
      [def('beta', '已被卸载的工具的陈旧副本')], // 寄存器仍持有 beta
    ),
  );
  assert.deepEqual(names, ['alpha'], 'beta 已不在目录中，不得并入');
});

test('D4：仍在目录中的发现项要并入，且取**目录中的最新定义**而非陈旧副本', () => {
  const deps = makeDeps(
    [def('alpha', 'a'), def('beta', '目录里的新描述')],
    [def('alpha', 'a')],
    [def('beta', '寄存器里的旧描述')],
  );
  const tools = new StepContextBuilder(deps).effectiveTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['alpha', 'beta'],
    'beta 仍在目录中 ⇒ 应并入',
  );
  assert.strictEqual(
    tools.find((t) => t.name === 'beta')?.description,
    '目录里的新描述',
    '必须用目录中的最新定义，否则参数 schema 变更后会喂给模型过期契约',
  );
});

test('D4：直载优先——同名工具已在直载集中时，不被发现结果覆盖', () => {
  const deps = makeDeps(
    [def('alpha', '目录描述')],
    [def('alpha', '直载描述')],
    [def('alpha', '寄存器描述')],
  );
  const tools = new StepContextBuilder(deps).effectiveTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['alpha'],
    '同名不得重复',
  );
  assert.strictEqual(tools[0]?.description, '直载描述');
});

test('D4：目录查询不可用（无 list）时退化为直载 ∪ 发现，不抛错', () => {
  const deps = {
    tools: { listDirect: () => [def('alpha', 'a')] }, // 无 list
    discovery: { list: () => [def('beta', 'b')] },
    recorder: { allEvents: () => [] },
    repoMapContext: {} as RepoMapContextEngine,
    fragments: [],
  } as unknown as StepRunnerDeps;
  assert.deepEqual(namesOf(deps), ['alpha', 'beta']);
});

/**
 * 构造「带真实 user 事件」的依赖（`OMNI_TOOL_EXPOSURE=plan` 下 `exposeByRelevance` 会读它）。
 * @param event 最近一条 user 事件。
 * @returns 可喂给 StepContextBuilder 的依赖契约。
 */
const makeDepsWithUser = (event: SessionEvent): StepRunnerDeps => {
  const tools = [
    def(TOOL_NAMES.readFile, '文件读'),
    def(TOOL_NAMES.writeFile, '文件写'),
    def(TOOL_NAMES.grep, '检索'),
    def(TOOL_NAMES.webFetch, '抓网页'),
    def(TOOL_NAMES.viewImage, '看图'),
    def(TOOL_NAMES.shell, '跑命令'),
    def(TOOL_NAMES.subagent, '子代理'),
    def(TOOL_NAMES.toolSearch, '找回工具'),
    def(TOOL_NAMES.askUser, '澄清'),
    def(TOOL_NAMES.todoWrite, '写待办'),
  ];
  return {
    tools: { list: () => tools, listDirect: () => tools },
    discovery: { list: () => [] },
    recorder: { allEvents: () => [event] },
    repoMapContext: {} as RepoMapContextEngine,
    fragments: [],
  } as unknown as StepRunnerDeps;
};

test('plan 模式：消费点（effectiveTools）真的按类别裁剪直载集——此前该分支零测试覆盖', () => {
  const deps = makeDepsWithUser(userEvent('帮我读一下这个文件'));
  const prev = process.env['OMNI_TOOL_EXPOSURE'];
  process.env['OMNI_TOOL_EXPOSURE'] = 'plan';
  try {
    const names = namesOf(deps);
    // 命中 files 类别 ⇒ 保留 read/write + 恒可见三通道。
    assert.ok(names.includes(TOOL_NAMES.readFile), 'files 类别必须保留');
    assert.ok(names.includes(TOOL_NAMES.writeFile), 'files 类别必须保留');
    // 恒可见通道不因「任务文本没提」而被藏起来（F18：规划工具是元能力）。
    assert.ok(names.includes(TOOL_NAMES.toolSearch), '找回通道必须恒可见');
    assert.ok(names.includes(TOOL_NAMES.askUser), '澄清通道必须恒可见');
    assert.ok(names.includes(TOOL_NAMES.todoWrite), '规划工具必须恒可见（F18）');
    // 未命中类别被延迟 ⇒ 直载集必须真的变小（否则「接线了」是假象）。
    assert.ok(!names.includes(TOOL_NAMES.viewImage), 'visual 类别应被延迟');
    assert.ok(!names.includes(TOOL_NAMES.subagent), 'delegate 类别应被延迟');
    assert.ok(!names.includes(TOOL_NAMES.webFetch), 'web 类别应被延迟');
    assert.ok(names.length < 10, `直载集应小于全集 10，实际 ${String(names.length)}`);
  } finally {
    if (prev === undefined) delete process.env['OMNI_TOOL_EXPOSURE'];
    else process.env['OMNI_TOOL_EXPOSURE'] = prev;
  }
});

test('plan 模式：无类别命中时 fail-safe 全量放行（宁多给不少给）', () => {
  const deps = makeDepsWithUser(userEvent('嗯'));
  const prev = process.env['OMNI_TOOL_EXPOSURE'];
  process.env['OMNI_TOOL_EXPOSURE'] = 'plan';
  try {
    // 「嗯」不含任何类别关键词 ⇒ 计划层 fail-safe 全放行，直载集必须与全集逐字相同。
    assert.strictEqual(namesOf(deps).length, 10);
  } finally {
    if (prev === undefined) delete process.env['OMNI_TOOL_EXPOSURE'];
    else process.env['OMNI_TOOL_EXPOSURE'] = prev;
  }
});

test('off 模式（默认）：直载集原样返回，零行为变更', () => {
  const deps = makeDepsWithUser(userEvent('帮我读一下这个文件'));
  const prev = process.env['OMNI_TOOL_EXPOSURE'];
  delete process.env['OMNI_TOOL_EXPOSURE'];
  try {
    assert.strictEqual(namesOf(deps).length, 10, '默认 off ⇒ 与接线前逐字等价');
  } finally {
    if (prev !== undefined) process.env['OMNI_TOOL_EXPOSURE'] = prev;
  }
});
