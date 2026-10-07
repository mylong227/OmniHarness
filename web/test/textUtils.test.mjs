// web 纯函数单测（node --test，无第三方依赖）。覆盖从 StreamView/ChangesTab 抽离的可测逻辑，
// 回应审计 P0「web 0 测试文件」。运行：npm run web:test（先 web:build 编译到 dist）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeToolCall,
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
} from '../dist/ui/textUtils.js';

test('describeToolCall 映射已知工具为人话动作', () => {
  assert.equal(describeToolCall('write_file', { path: 'examples/index.js' }), '写入 examples/index.js');
  assert.equal(describeToolCall('apply_patch', { path: 'a/b.ts' }), '修改 a/b.ts');
  assert.equal(describeToolCall('bash', { command: 'npm test' }), '执行命令 npm test');
  assert.equal(describeToolCall('search', { pattern: 'foo' }), '搜索 foo');
  assert.equal(describeToolCall('delegate', { task: '调研 X' }), '委派子任务 调研 X');
  assert.equal(describeToolCall('unknown_tool', { x: 1 }), 'unknown_tool（x=1）');
  assert.equal(describeToolCall('unknown_tool', {}), '调用 unknown_tool');
});

test('processSummary 叙述式聚合', () => {
  const events = [
    { type: 'reasoning', id: '1', timestamp: 0 },
    { type: 'tool_call', id: '2', timestamp: 0, payload: { name: 'write_file', path: 'a' } },
    { type: 'tool_call', id: '3', timestamp: 0, payload: { name: 'bash', command: 'x' } },
    { type: 'tool_call', id: '4', timestamp: 0, payload: { name: 'read_file', path: 'b' } },
  ];
  const s = processSummary(events);
  assert.match(s, /思考 1 次/);
  assert.match(s, /写入了 1 个文件/);
  assert.match(s, /执行了 1 条命令/);
  assert.match(s, /读取了 1 个文件/);
});

test('buildDisplayBlocks 非忙碌时折叠过程事件', () => {
  const events = [
    { type: 'user', id: '1', timestamp: 0 },
    { type: 'reasoning', id: '2', timestamp: 0 },
    { type: 'tool_call', id: '3', timestamp: 0, payload: { name: 'bash' } },
    { type: 'assistant', id: '4', timestamp: 0 },
  ];
  const blocks = buildDisplayBlocks(events, false);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].kind, 'process');
  assert.equal(blocks[1].events.length, 2);
});

test('buildDisplayBlocks 忙碌时不折叠', () => {
  const events = [
    { type: 'reasoning', id: '1', timestamp: 0 },
    { type: 'tool_call', id: '2', timestamp: 0, payload: { name: 'bash' } },
  ];
  const blocks = buildDisplayBlocks(events, true);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'single');
});

test('extractUrls 去重并剔除末尾标点', () => {
  const urls = extractUrls('见 https://a.com. 与 https://a.com 与 http://b.com');
  assert.deepEqual(urls, ['https://a.com', 'http://b.com']);
});

test('hostOf 解析主机名', () => {
  assert.equal(hostOf('https://example.com/x'), 'example.com');
  assert.equal(hostOf('not a url'), 'not a url');
});

test('statusBadge 映射 git 状态', () => {
  assert.equal(statusBadge('??').label, '新增');
  assert.equal(statusBadge('A').label, '新增');
  assert.equal(statusBadge('D').label, '删除');
  assert.equal(statusBadge('R').label, '重命名');
  assert.equal(statusBadge('M').label, '修改');
});

test('parseHunks 统计增删行', () => {
  const patch = `@@ -1,3 +1,4 @@
 line1
-line2
+line2new
+line3new
 line3`;
  const hunks = parseHunks(patch);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].additions, 2);
  assert.equal(hunks[0].deletions, 1);
});

test('truncate 超长加省略号', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});

test('argSummary 取标量参数', () => {
  assert.equal(argSummary({ path: 'a/b.js', mode: 'x' }), 'path=a/b.js · mode=x');
  assert.equal(argSummary(null), '');
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
  assert.equal(rows[0].kind, 'meta');
  assert.equal(rows[1].kind, 'meta');
  assert.equal(rows[2].kind, 'hunk');
  assert.equal(rows[3].kind, 'ctx');
  assert.equal(rows[3].oldNo, 1);
  assert.equal(rows[3].newNo, 1);
  assert.equal(rows[4].kind, 'del');
  assert.equal(rows[4].oldNo, 2);
  assert.equal(rows[5].kind, 'add');
  assert.equal(rows[5].newNo, 2);
  assert.equal(rows[6].kind, 'add');
  assert.equal(rows[6].newNo, 3);
});

test('parseDiffRows 处理无 @@ 的新文件补丁', () => {
  const patch = '--- /dev/null\n+++ new.ts\n+alpha\n+beta';
  const rows = parseDiffRows(patch);
  assert.equal(rows[0].kind, 'meta');
  assert.equal(rows[1].kind, 'meta');
  assert.equal(rows[2].kind, 'add');
  assert.equal(rows[2].newNo, 1);
  assert.equal(rows[3].newNo, 2);
});

test('parseDiffRows 空输入 fail-closed', () => {
  assert.deepEqual(parseDiffRows(''), []);
});

test('timeAgo 相对时间', () => {
  const now = new Date().toISOString();
  assert.equal(timeAgo(now), '刚刚');
  assert.equal(timeAgo(undefined), '');
  assert.equal(timeAgo('not-a-date'), '');
});

// 2026-10-07 用户截图：「结果不应该被收进过程中，应该单独的显示出来」——写文件/打补丁的调用会带出
// 产物卡（ArtifactCard），那是这一轮的**结果**；此前它和其他工具调用一起被折进「执行过程」折叠块。
test('buildDisplayBlocks：产物类调用单独成块（不折进「执行过程」）', () => {
  const events = [
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