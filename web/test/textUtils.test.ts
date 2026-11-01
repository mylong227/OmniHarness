// web 纯函数单测（node --test，无第三方依赖）。覆盖从 StreamView/ChangesTab 抽离的可测逻辑，
// 回应审计 P0「web 0 测试文件」。运行：npm run web:test（先 web:build 编译到 dist）。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  describeToolCall,
  toolVerb,
  toolSubject,
  toolMeta,
  processSummary,
  buildDisplayBlocks,
  extractUrls,
  hostOf,
  statusBadge,
  parseHunks,
  parseDiffRows,
  timeAgo,
  truncate,
  argSummary,
} from '../src/ui/textUtils.ts';
import type { ThreadEvent } from '../src/types/models.ts';

test('describeToolCall 映射已知工具为人话动作', () => {
  assert.strictEqual(describeToolCall('write_file', { path: 'examples/index.js' }), '写入 examples/index.js');
  assert.strictEqual(describeToolCall('apply_patch', { path: 'a/b.ts' }), '修改 a/b.ts');
  assert.strictEqual(describeToolCall('bash', { command: 'npm test' }), '执行命令 npm test');
  assert.strictEqual(describeToolCall('search', { pattern: 'foo' }), '搜索 foo');
  assert.strictEqual(describeToolCall('delegate', { task: '调研 X' }), '委派子任务 调研 X');
  // 2026-10-20：轨迹里此前直接露 `memory_search(...)` / `run_code(...)`；
  // 现在走中文动作 + 语义对象，不再显示接口名。
  assert.strictEqual(describeToolCall('memory_search', { limit: 15, query: 'bug 清单' }), '检索记忆 · bug 清单');
  assert.strictEqual(describeToolCall('run_code', { code: 'const x = 1' }), '运行代码 · const x = 1');
  assert.strictEqual(describeToolCall('web_fetch', { url: 'https://x.test' }), '抓取网页 · https://x.test');
  assert.strictEqual(describeToolCall('edit', { path: 'a/b.ts' }), '编辑 · a/b.ts');
  assert.strictEqual(describeToolCall('mcp', { tool: 'search' }), '调用 MCP · search');
  // 未登记工具也不得直接露接口名：退成「调用工具（参数摘要）」。
  assert.strictEqual(describeToolCall('unknown_tool', { x: 1 }), '调用工具（x=1）');
  assert.strictEqual(describeToolCall('unknown_tool', {}), '调用工具');
});

test('全部内建工具都有中文动作，任何一条都不返回接口名', () => {
  const names = [
    'read_file',
    'list_dir',
    'glob',
    'grep',
    'write_file',
    'edit',
    'apply_patch',
    'patch_candidates',
    'workflow_memory',
    'shell',
    'shell_job',
    'shell_interactive',
    'run_code',
    'delegate',
    'a2a_delegate',
    'subagent',
    'browser_screenshot',
    'rollback',
    'checkpoint',
    'remember',
    'recall',
    'memory_search',
    'todo_write',
    'todo_read',
    'capability_metadata',
    'plan_read',
    'plan_write',
    'plan_present',
    'ask_user',
    'tool_search',
    'spill_read',
    'budget_status',
    'sketch_write',
    'view_image',
    'view_media',
    'web_search',
    'web_fetch',
    'policy_eval',
    'agent_identity',
    'run_goal',
    'run_workflow',
    'registry',
    'lsp_go_to_definition',
    'lsp_find_references',
    'lsp_hover',
    'lsp_status',
    'lsp_diagnostics',
    'lsp_document_symbols',
    'lsp_code_action',
    'lsp_workspace_symbols',
  ];
  for (const name of names) {
    const action = describeToolCall(name, {});
    assert.ok(!action.includes(name), `${name} 仍直接显示接口名：${action}`);
    assert.notStrictEqual(action, '调用工具', `${name} 缺少中文动作映射`);
    assert.notStrictEqual(toolVerb(name), '调用', `${name} 缺少中文步骤标签`);
  }
});

test('toolVerb / toolSubject：步骤行是「动作标签 + 对象」，不出现工具名', () => {
  assert.strictEqual(toolVerb('read_file'), '读取');
  assert.strictEqual(toolVerb('write_file'), '写入');
  assert.strictEqual(toolVerb('apply_patch'), '编辑');
  assert.strictEqual(toolVerb('shell'), '运行命令');
  assert.strictEqual(toolVerb('bash'), '运行命令');
  assert.strictEqual(toolVerb('sketch_write'), '生成草图');
  assert.strictEqual(toolVerb('memory_search'), '检索记忆');
  assert.strictEqual(toolVerb('run_code'), '运行代码');
  assert.strictEqual(toolVerb('unknown_tool'), '调用');

  assert.strictEqual(toolSubject('memory_search', { query: 'bug 清单' }), 'bug 清单');
  assert.strictEqual(toolSubject('run_code', { code: 'const x = 1' }), 'const x = 1');
  assert.strictEqual(toolSubject('read_file', { path: 'a/b.ts' }), 'a/b.ts');
  assert.strictEqual(toolSubject('shell', { command: 'npm test' }), 'npm test');
  assert.strictEqual(toolSubject('search', { pattern: 'foo' }), 'foo');
  assert.strictEqual(toolSubject('sketch_write', { title: '草图 A' }), '草图 A');
  assert.strictEqual(toolSubject('unknown_tool', { x: 1 }), 'x=1');
  // apply_patch 没显式 path 时从补丁头取目标文件。
  assert.strictEqual(
    toolSubject('apply_patch', { patch: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b' }),
    'x.ts',
  );
});

test('toolMeta：写入体积 + 新增行；编辑补丁含删除行', () => {
  assert.strictEqual(toolMeta('write_file', { content: 'a\nb' }), '3 B +2 −0');
  const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n+c';
  const meta = toolMeta('apply_patch', { patch });
  assert.ok(meta.endsWith(' +2 −1'), `补丁增删统计不对：${meta}`);
  assert.strictEqual(toolMeta('read_file', { path: 'a.ts' }), '');
});

test('processSummary 叙述式聚合', () => {
  const events: ThreadEvent[] = [
    { type: 'reasoning', id: '1', timestamp: 0 },
    { type: 'tool_call', id: '2', timestamp: 0, payload: { name: 'write_file', path: 'a' } },
    { type: 'tool_call', id: '3', timestamp: 0, payload: { name: 'bash', command: 'x' } },
    { type: 'tool_call', id: '4', timestamp: 0, payload: { name: 'read_file', path: 'b' } },
    { type: 'tool_call', id: '5', timestamp: 0, payload: { name: 'apply_patch', path: 'c' } },
    { type: 'tool_call', id: '6', timestamp: 0, payload: { name: 'sketch_write', title: 'd' } },
    { type: 'assistant', id: '7', timestamp: 0, payload: { content: '我先读一下现有实现。' } },
  ];
  const s = processSummary(events);
  assert.match(s, /思考 1 次/);
  assert.match(s, /说明 1 次/, '过程旁白计成「说明 N 次」');
  assert.match(s, /写入了 1 个文件/);
  assert.match(s, /修改了 1 个文件/);
  assert.match(s, /生成了 1 张草图/);
  assert.match(s, /执行了 1 条命令/);
  assert.match(s, /读取了 1 个文件/);
});

// 2026-11-01 用户二次澄清：读序必须是「对话 → 总思考 → 总结结果（最终答复）→ 结果卡」。
test('buildDisplayBlocks：思考轨迹在最终答复之前（聊天下方、总结结果上方）', () => {
  const events: ThreadEvent[] = [
    { type: 'user', id: '1', timestamp: 0 },
    { type: 'reasoning', id: '2', timestamp: 0 },
    { type: 'tool_call', id: '3', timestamp: 0, payload: { name: 'bash' } },
    { type: 'assistant', id: '4', timestamp: 0 },
  ];
  const blocks = buildDisplayBlocks(events, false);
  assert.deepStrictEqual(
    blocks.map((b) => (b.kind === 'single' ? 'single:' + b.event.id : b.kind)),
    ['single:1', 'process', 'single:4'],
    '用户消息 → 总思考 → 最终答复',
  );
  if (blocks[1].kind !== 'process') throw new Error('缺少过程块');
  assert.strictEqual(blocks[1].events.length, 2);
});

// 2026-11-01 用户截图：一轮里夹着多条「我先看看 / 让我读一下 / 事实核对完毕…」的助手消息，
// 它们其实是思考的步骤，平铺会把对话撑满 ⇒ 收进轨迹；本轮最后一条（最终答复）留在对话里。
test('buildDisplayBlocks：中间的助手消息收进思考轨迹，最终答复留在对话里', () => {
  const events: ThreadEvent[] = [
    { type: 'user', id: 'u1', timestamp: 1, payload: { content: '调研一下' } },
    { type: 'assistant', id: 'a1', timestamp: 2, payload: { content: '我先看看工作区里已有的产物。' } },
    { type: 'reasoning', id: 'r1', timestamp: 3, payload: { content: '读报告' } },
    { type: 'tool_call', id: 'c1', timestamp: 4, payload: { callId: 'k1', name: 'read_file', args: { path: 'a.md' } } },
    { type: 'tool_result', id: 'x1', timestamp: 5, payload: { callId: 'k1', ok: true, output: 'ok' } },
    { type: 'assistant', id: 'a2', timestamp: 6, payload: { content: '让我再核对一下结论。' } },
    { type: 'tool_call', id: 'c2', timestamp: 7, payload: { callId: 'k2', name: 'shell', args: { cmd: 'npm run build' } } },
    { type: 'tool_result', id: 'x2', timestamp: 8, payload: { callId: 'k2', ok: true, output: 'ok' } },
    { type: 'assistant', id: 'a3', timestamp: 9, payload: { content: '最终答复：方案如下。' } },
  ];
  const blocks = buildDisplayBlocks(events, false);
  const process = blocks.find((b) => b.kind === 'process');
  if (process === undefined || process.kind !== 'process') throw new Error('缺少过程块');
  assert.deepStrictEqual(
    process.events.map((e) => e.id),
    ['a1', 'r1', 'c1', 'x1', 'a2', 'c2', 'x2'],
    '过程旁白按原顺序与思考/工具同处一条轨迹',
  );
  const singles = blocks.flatMap((b) => (b.kind === 'single' ? [b.event.id] : []));
  assert.deepStrictEqual(singles, ['u1', 'a3'], '只有用户消息与最终答复留在对话里');
  assert.deepStrictEqual(
    blocks.map((b) => (b.kind === 'single' ? 'single:' + b.event.id : b.kind)),
    ['single:u1', 'process', 'single:a3'],
    '轨迹在最终答复之前',
  );
  assert.match(processSummary(process.events), /说明 2 次/, '旁白计成「说明 N 次」');
});

test('buildDisplayBlocks：没有 user 起点的合成流不折叠助手消息（防误判）', () => {
  const events: ThreadEvent[] = [
    { type: 'assistant', id: 'a1', timestamp: 1, payload: { content: '一' } },
    { type: 'system', id: 's1', timestamp: 2, payload: { content: 'x' } },
    { type: 'assistant', id: 'a2', timestamp: 3, payload: { content: '二' } },
  ];
  const blocks = buildDisplayBlocks(events, false);
  assert.strictEqual(blocks.filter((b) => b.kind === 'process').length, 0);
  assert.strictEqual(blocks.filter((b) => b.kind === 'single').length, 3);
});

test('buildDisplayBlocks：运行中也只有一条轨迹（不存在「思考单块 + 工具簇」两条）', () => {
  const events: ThreadEvent[] = [
    { type: 'reasoning', id: '1', timestamp: 0 },
    { type: 'tool_call', id: '2', timestamp: 0, payload: { name: 'bash' } },
  ];
  const blocks = buildDisplayBlocks(events, true);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'process');
  if (blocks[0].kind !== 'process') throw new Error('缺少过程块');
  assert.strictEqual(blocks[0].events.length, 2, '思考与工具调用同处一条时间线');
});

test('buildDisplayBlocks：没有 turn_diff 但产出了文件 → 仍补一张结果卡（产物只集中在卡里）', () => {
  const events: ThreadEvent[] = [
    { type: 'user', id: 'u1', timestamp: 1 },
    { type: 'tool_call', id: 'c1', timestamp: 2, payload: { callId: 'k1', name: 'write_file', args: { path: 'docs/x.md' } } },
    { type: 'tool_result', id: 'r1', timestamp: 3, payload: { callId: 'k1', ok: true, output: '已写入 docs/x.md' } },
  ];
  const blocks = buildDisplayBlocks(events, false);
  const summary = blocks.find((b) => b.kind === 'turn_summary');
  assert.ok(summary !== undefined, '写类工具产出了文件，就必须有结果卡兜底');
  const inlineWrites = blocks.filter((b) => b.kind === 'single' && b.event.payload?.name === 'write_file');
  assert.strictEqual(inlineWrites.length, 0, '产物调用不得再单独成块（文件卡只能出现在结果卡里）');
  const inTrail = blocks.some(
    (b) => b.kind === 'process' && b.events.some((e) => e.payload?.name === 'write_file'),
  );
  assert.strictEqual(inTrail, true, '写入动作本身仍留在思考轨迹里');
  // 运行中不补卡：文件还没写完，卡片会反复抖。
  assert.strictEqual(
    buildDisplayBlocks(events, true).some((b) => b.kind === 'turn_summary'),
    false,
  );
});

test('extractUrls 去重并剔除末尾标点', () => {
  const urls = extractUrls('见 https://a.com. 与 https://a.com 与 http://b.com');
  assert.deepEqual(urls, ['https://a.com', 'http://b.com']);
});

test('hostOf 解析主机名', () => {
  assert.strictEqual(hostOf('https://example.com/x'), 'example.com');
  assert.strictEqual(hostOf('not a url'), 'not a url');
});

test('statusBadge 映射 git 状态', () => {
  assert.strictEqual(statusBadge('??').label, '新增');
  assert.strictEqual(statusBadge('A').label, '新增');
  assert.strictEqual(statusBadge('D').label, '删除');
  assert.strictEqual(statusBadge('R').label, '重命名');
  assert.strictEqual(statusBadge('M').label, '修改');
});

test('parseHunks 统计增删行', () => {
  const patch = `@@ -1,3 +1,4 @@
 line1
-line2
+line2new
+line3new
 line3`;
  const hunks = parseHunks(patch);
  assert.strictEqual(hunks.length, 1);
  assert.strictEqual(hunks[0].additions, 2);
  assert.strictEqual(hunks[0].deletions, 1);
});

test('truncate 超长加省略号', () => {
  assert.strictEqual(truncate('abcdef', 4), 'abc…');
  assert.strictEqual(truncate('abc', 4), 'abc');
});

test('argSummary 取标量参数', () => {
  assert.strictEqual(argSummary({ path: 'a/b.js', mode: 'x' }), 'path=a/b.js · mode=x');
  assert.strictEqual(argSummary(null), '');
});

test('parseDiffRows 解析 unified diff 行号', () => {
  const patch = [
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -1,3 +1,4 @@',
    ' context',
    '-old line',
    '+new line',
    '+second new',
  ].join('\n');
  const rows = parseDiffRows(patch);
  assert.strictEqual(rows[0].kind, 'meta');
  assert.strictEqual(rows[1].kind, 'meta');
  assert.strictEqual(rows[2].kind, 'hunk');
  assert.strictEqual(rows[3].kind, 'ctx');
  assert.strictEqual(rows[3].oldNo, 1);
  assert.strictEqual(rows[3].newNo, 1);
  assert.strictEqual(rows[4].kind, 'del');
  assert.strictEqual(rows[4].oldNo, 2);
  assert.strictEqual(rows[5].kind, 'add');
  assert.strictEqual(rows[5].newNo, 2);
  assert.strictEqual(rows[6].kind, 'add');
  assert.strictEqual(rows[6].newNo, 3);
});

test('parseDiffRows 处理无 @@ 的新文件补丁', () => {
  const patch = '--- /dev/null\n+++ new.ts\n+alpha\n+beta';
  const rows = parseDiffRows(patch);
  assert.strictEqual(rows[0].kind, 'meta');
  assert.strictEqual(rows[1].kind, 'meta');
  assert.strictEqual(rows[2].kind, 'add');
  assert.strictEqual(rows[2].newNo, 1);
  assert.strictEqual(rows[3].newNo, 2);
});

test('parseDiffRows 空输入 fail-closed', () => {
  assert.deepEqual(parseDiffRows(''), []);
});

test('timeAgo 相对时间', () => {
  const now = new Date().toISOString();
  assert.strictEqual(timeAgo(now), '刚刚');
  assert.strictEqual(timeAgo(undefined), '');
  assert.strictEqual(timeAgo('not-a-date'), '');
});

test('buildDisplayBlocks：turn_diff 收口成结果块，产物调用收进思考轨迹（不再散落）', () => {
  const events: ThreadEvent[] = [
    { id: 'u1', type: 'user', timestamp: 1 },
    { id: 'r1', type: 'reasoning', timestamp: 2, payload: { content: '想一下' } },
    { id: 'c1', type: 'tool_call', timestamp: 3, payload: { callId: 'k1', name: 'write_file', args: { path: 'docs/x.md' } } },
    { id: 'x1', type: 'tool_result', timestamp: 4, payload: { callId: 'k1', ok: true, output: '已写入' } },
    { id: 'a1', type: 'assistant', timestamp: 5, payload: { content: '完成' } },
    { id: 'd1', type: 'turn_diff', timestamp: 6, payload: { diff: '--- a/docs/x.md\n+++ b/docs/x.md\n@@ -0,0 +1,1 @@\n+x' } },
  ];
  const blocks = buildDisplayBlocks(events, false);
  const summary = blocks.find((b) => b.kind === 'turn_summary');
  assert.ok(summary !== undefined, '应产出 turn_summary 块');
  if (summary === undefined || summary.kind !== 'turn_summary') throw new Error('缺少结果块');
  assert.strictEqual(summary.key, 'd1');
  assert.strictEqual(summary.events.length, events.length, '结果块拿到本轮全部可见事件');
  const writes = blocks.filter((b) => b.kind === 'single' && b.event.payload?.name === 'write_file');
  assert.strictEqual(writes.length, 0, '已收编的产物调用不得再单独成块');
  const inProcess = blocks.some(
    (b) => b.kind === 'process' && b.events.some((e) => e.payload?.name === 'write_file'),
  );
  assert.strictEqual(inProcess, true, '已收编的产物调用留在过程摘要里（只讲做了什么）');
});