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
  ];
  const s = processSummary(events);
  assert.match(s, /思考 1 次/);
  assert.match(s, /写入了 1 个文件/);
  assert.match(s, /修改了 1 个文件/);
  assert.match(s, /生成了 1 张草图/);
  assert.match(s, /执行了 1 条命令/);
  assert.match(s, /读取了 1 个文件/);
});

test('buildDisplayBlocks 非忙碌时折叠过程事件', () => {
  const events: ThreadEvent[] = [
    { type: 'user', id: '1', timestamp: 0 },
    { type: 'reasoning', id: '2', timestamp: 0 },
    { type: 'tool_call', id: '3', timestamp: 0, payload: { name: 'bash' } },
    { type: 'assistant', id: '4', timestamp: 0 },
  ];
  const blocks = buildDisplayBlocks(events, false);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[1].kind, 'process');
  assert.strictEqual(blocks[1].events.length, 2);
});

test('buildDisplayBlocks 忙碌时：思考保持实时单块，工具折成一行活动摘要', () => {
  const events: ThreadEvent[] = [
    { type: 'reasoning', id: '1', timestamp: 0 },
    { type: 'tool_call', id: '2', timestamp: 0, payload: { name: 'bash' } },
  ];
  const blocks = buildDisplayBlocks(events, true);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].kind, 'single');
  assert.strictEqual(blocks[1].kind, 'process', '运行中的工具调用不再一条一行地铺开');
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

// 2026-10-07 用户截图：「结果不应该被收进过程中，应该单独的显示出来」——写文件/打补丁的调用会带出
// 产物卡（ArtifactCard），那是这一轮的**结果**。在没有 turn_diff 的兜底路径（运行中 / diff 失效）
// 它仍单独成块；一旦 turn_diff 收口，产物进入「回合结果卡」，过程里不再重复出现。
test('buildDisplayBlocks：无 turn_diff 时产物调用单独成块（兜底）', () => {
  const events: ThreadEvent[] = [
    { id: 'r1', type: 'reasoning', timestamp: 1, payload: { content: '想一下' } },
    { id: 'c1', type: 'tool_call', timestamp: 2, payload: { callId: 'k1', name: 'read_file', args: { path: 'a.ts' } } },
    { id: 'x1', type: 'tool_result', timestamp: 3, payload: { callId: 'k1', ok: true, output: 'ok' } },
    { id: 'c2', type: 'tool_call', timestamp: 4, payload: { callId: 'k2', name: 'write_file', args: { path: 'docs/x.md' } } },
    { id: 'x2', type: 'tool_result', timestamp: 5, payload: { callId: 'k2', ok: true, output: '已写入' } },
    { id: 'c3', type: 'tool_call', timestamp: 6, payload: { callId: 'k3', name: 'shell', args: { command: 'ls' } } },
    { id: 'x3', type: 'tool_result', timestamp: 7, payload: { callId: 'k3', ok: true, output: 'a.ts' } },
  ];
  const blocks = buildDisplayBlocks(events, false);
  const writes = blocks.filter((b) => b.kind === 'single' && b.event.payload?.name === 'write_file');
  assert.strictEqual(writes.length, 1, 'write_file 必须单独成块（结果不被收进过程）');
  const inProcess = blocks.some(
    (b) => b.kind === 'process' && b.events.some((e) => e.payload?.name === 'write_file'),
  );
  assert.strictEqual(inProcess, false, 'write_file 不得出现在任何「执行过程」折叠块里');
  // 其余工具/思考仍照旧聚合（本次只动产物类）
  const process = blocks.filter((b) => b.kind === 'process');
  assert.ok(process.length >= 1, '读文件与 shell 仍应聚合为过程块');
  const names = process.flatMap((b) => b.events.map((e) => e.payload?.name)).filter(Boolean);
  assert.ok(names.includes('read_file') && names.includes('shell'), '过程块仍含读文件与 shell');
});

test('buildDisplayBlocks：turn_diff 收口成结果块，产物调用折进过程（不再散落）', () => {
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