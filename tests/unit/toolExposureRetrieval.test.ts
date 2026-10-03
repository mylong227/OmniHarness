/**
 * **工具暴露检索优先 + 确定性排序**判据（G10-T2，2026-10-03 第二十五轮）。
 *
 * ## 修的是什么
 *
 * 报告的 T2：规范处方是"**先检索再给模型**"，而本仓的 planner 只有**类别关键词命中**——
 * 工具没被登记进命中类别的 `tools` 列表时，哪怕它的**描述**与任务高度相关也会被延迟；
 * 另外输出顺序沿用输入顺序（注册顺序），而注册顺序会因插件装载/条件注册而变，
 * 于是进 prompt 前缀的 schema 块顺序漂移，**prompt cache 全废**。
 *
 * ## 判据（报告 T2 原话："`OMNI_TOOL_EXPOSURE=plan` 下确定性对比（同输入恒同输出 + 必需工具召回 100%）"）
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | **同输入恒同输出**：同一输入连跑 3 次，结果逐位相同 |
 * | ② | **与输入排列无关**：把 `tools` 数组打乱，输出仍逐位相同（顺序由名字决定，不由注册序决定） |
 * | ③ | **必需工具召回 100%**：任务文本与工具**描述**相关、但该工具**不在命中类别的名单里**时，BM25 路必须把它捞进可见集 |
 * | ④ | **检索只增不减**：开检索后的可见集 ⊇ 关检索时的可见集（不会因检索漏召回而丢类别该给的工具） |
 * | ⑤ | **fail-safe 不变**：无类别命中 ⇒ 全部可见（检索路不得把它变成"部分可见"） |
 * | ⑥ | **`tools/list` 确定性**：MCP 服务端列举工具按名字升序（与注册顺序无关） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ToolExposurePlanner } from '../../src/core/toolExposurePlanner.js';
import type { ToolCategory } from '../../src/core/toolExposurePlanner.js';
import { McpServer } from '../../src/mcp/mcpServer.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';

/**
 * 最小类别表：`exec` 登记 `shell`；`audit` 登记 `audit_query` 但**关键词与任务文本不相交**。
 *
 * 为什么必须把 `audit_query` 登记进某个类别：**未登记进任何类别的工具本来就恒可见**（保守设计），
 * 那样它就测不出检索路的贡献了。登记进一个"不会被命中"的类别后，它才是**可延迟**的——
 * 于是"BM25 依据描述把它捞回来"这件事才有可观测差异（本判据首版正是在这里踩空）。
 */
const CATEGORIES: readonly ToolCategory[] = [
  { id: 'exec', hint: '执行', keywords: ['测试', 'test', 'run'], tools: ['shell'] },
  { id: 'audit', hint: '合规取证', keywords: ['compliance', '合规取证'], tools: ['audit_query'] },
];

/** 工具集（故意**乱序**，并把 `audit_query` 放在末尾——它不在任何类别的 tools 名单里）。 */
const TOOLS: readonly string[] = ['shell', 'write_file', 'read_file', 'audit_query'];

/** 工具文本：`audit_query` 的描述里含"测试/审批"这类任务词，但类别没登记它。 */
const TEXTS = new Map<string, string>([
  ['shell', '执行 shell 命令并返回输出'],
  ['write_file', '写入工作区文件'],
  ['read_file', '读取工作区文件'],
  ['audit_query', '查询审批审计记录：谁在何时批准了哪次测试运行（测试与审计联动排查）'],
]);

/** 造一个只读工具端口（供 MCP 服务端列举）。 */
function stubToolPort(): ToolPort {
  const definitions = [
    { name: 'zeta_tool', description: 'z', parameters: { type: 'object', properties: {} } },
    { name: 'alpha_tool', description: 'a', parameters: { type: 'object', properties: {} } },
    { name: 'mu_tool', description: 'm', parameters: { type: 'object', properties: {} } },
  ];
  return {
    list: () =>
      definitions.map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.parameters as never,
      })),
  } as unknown as ToolPort;
}

test('① 同输入恒同输出（连跑 3 次逐位相同）', () => {
  const run = () =>
    ToolExposurePlanner.plan({
      taskText: '跑一下测试',
      tools: TOOLS,
      categories: CATEGORIES,
      toolTexts: TEXTS,
    });
  const [a, b, c] = [run(), run(), run()];
  assert.deepEqual(a.visible, b.visible);
  assert.deepEqual(b.visible, c.visible);
  assert.deepEqual(a.deferred, c.deferred);
});

test('② 与输入排列无关（打乱 tools ⇒ 输出逐位相同）', () => {
  const base = ToolExposurePlanner.plan({
    taskText: '跑一下测试',
    tools: TOOLS,
    categories: CATEGORIES,
    toolTexts: TEXTS,
  });
  const shuffled = ToolExposurePlanner.plan({
    taskText: '跑一下测试',
    tools: [...TOOLS].reverse(),
    categories: CATEGORIES,
    toolTexts: TEXTS,
  });
  assert.deepEqual(
    shuffled.visible,
    base.visible,
    '输出顺序必须由名字决定，而不是由注册/输入顺序决定（否则 prompt 前缀会漂移）',
  );
  assert.deepEqual(shuffled.deferred, base.deferred);
  // 顺带钉住"升序"这一具体口径（避免有人改成"按分数排序"而悄悄失去稳定性）。
  assert.deepEqual([...base.visible], [...base.visible].sort());
});

test('③ 必需工具召回 100%：描述相关但不在命中类别名单里的工具必须被捞回', () => {
  const withRetrieval = ToolExposurePlanner.plan({
    taskText: '谁批准了这次测试运行？查一下审批审计',
    tools: TOOLS,
    categories: CATEGORIES,
    toolTexts: TEXTS,
  });
  assert.ok(
    withRetrieval.visible.includes('audit_query'),
    `必需工具 audit_query 必须可见（实得 ${withRetrieval.visible.join(',')}）：类别没登记它，靠 BM25 路捞回`,
  );
  assert.match(withRetrieval.reason, /BM25 检索补入 [1-9]/, '理由里应如实报出检索补入数量');

  // 反证：**不给** toolTexts（旧行为）时它确实不在可见集里 —— 说明这条判据不是白给。
  const withoutRetrieval = ToolExposurePlanner.plan({
    taskText: '谁批准了这次测试运行？查一下审批审计',
    tools: TOOLS,
    categories: CATEGORIES,
  });
  assert.ok(
    !withoutRetrieval.visible.includes('audit_query'),
    '关掉检索路时 audit_query 应被延迟（否则③测不出检索路的贡献）',
  );
});

test('④ 检索只增不减：开检索后的可见集 ⊇ 关检索时的可见集', () => {
  for (const taskText of ['跑一下测试', '谁批准了这次测试运行', '读一下配置']) {
    const off = ToolExposurePlanner.plan({
      taskText,
      tools: TOOLS,
      categories: CATEGORIES,
      retrievalTopK: 0,
    });
    const on = ToolExposurePlanner.plan({
      taskText,
      tools: TOOLS,
      categories: CATEGORIES,
      toolTexts: TEXTS,
    });
    for (const name of off.visible) {
      assert.ok(on.visible.includes(name), `检索路不得丢工具：${name} 在关闭时可见、开启后消失了`);
    }
  }
});

test('⑤ fail-safe 不变：无类别命中 ⇒ 全部可见（含开检索时）', () => {
  const plan = ToolExposurePlanner.plan({
    taskText: '帮我把这个仓库的目录结构画出来',
    tools: TOOLS,
    categories: CATEGORIES,
    toolTexts: TEXTS,
  });
  assert.deepEqual([...plan.visible].sort(), [...TOOLS].sort(), '无类别命中必须全放行（保守设计）');
  assert.deepEqual([...plan.deferred], []);
});

test('⑥ tools/list 确定性：MCP 服务端按名字升序列举（与注册顺序无关）', async () => {
  const server = new McpServer({
    tools: stubToolPort(),
    // 本判据只调私有 `listTools()`，故传输只需满足构造期的回调注册。
    transport: {
      onMessage: () => undefined,
      send: async () => undefined,
      close: () => undefined,
    },
  } as never);
  const call = async (): Promise<string[]> => {
    const response = (await (
      server as unknown as {
        listTools(): Promise<{ readonly tools: readonly { readonly name: string }[] }>;
      }
    ).listTools()) as { readonly tools: readonly { readonly name: string }[] };
    return response.tools.map((tool) => tool.name);
  };
  const first = await call();
  const second = await call();
  assert.deepEqual(first, ['alpha_tool', 'mu_tool', 'zeta_tool'], 'tools/list 必须按名字升序');
  assert.deepEqual(second, first, '两次列举必须逐位相同（顺序是 prompt 前缀的一部分）');
});

test('⑦ 接线：生产路径必须真的把工具文本交给规划器（声明未接线 = 本仓最高频缺陷）', () => {
  // 这一条为什么必要：本判据首版只测规划器本身，规划器全绿、**生产却根本没传 toolTexts**
  // ⇒ BM25 检索路在生产里是死的。判据必须覆盖"调用点是否接线"，否则绿得毫无意义。
  const src = readFileSync(join(process.cwd(), 'src/core/stepContextBuilder.ts'), 'utf8');
  assert.match(
    src,
    /ToolExposurePlanner\.plan\(\{[\s\S]{0,400}?toolTexts/,
    '生产调用点未把 toolTexts 交给规划器 ⇒ 检索路不会生效（声明即接线）',
  );
  assert.match(src, /tool\.description/, '工具文本必须含**描述**（只给名字则 BM25 无语料可检）');
});
