/**
 * CodexLineWriter 直接判据（2026-11-04 盘点批次）。
 *
 * 背景：全仓健康扫描发现该文件（audit 应用**最大文件**，433 行）在整个 tests 树里
 * 没有**文件名级**引用——只经 auditParsers 的夹具间接覆盖（58.6%）。本判据把两条支路
 * （`response_item` / `event_msg`）的口径**逐分支**钉死：去重双向、apply_patch 文件、
 * token_count 累计取最后、exec begin/end 的 seenCalls 旁路——这些是 §207.2 说
 * 「判据钉死」的那批口径，此前只有夹具级正对照，没有分支级判据。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CodexLineWriter } from '../../src/apps/audit/codexLineWriter.ts';
import type { CodexParseContext } from '../../src/apps/audit/codexParseContext.ts';

/** 空上下文（与 `CodexSessionParser.emptyContext` 同形）。 */
function ctx(hasResponseMessages = false): CodexParseContext {
  return {
    records: [],
    seenCalls: new Set<string>(),
    hasResponseMessages,
    tokens: { prompt: 0, completion: 0, cached: 0, total: 0, sawUsage: false },
  };
}

test('① response_item 全型：message / reasoning / function_call / output / shell / custom / 未知', () => {
  const context = ctx();
  CodexLineWriter.read(
    context,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '加个函数' }] },
    't1',
  );
  CodexLineWriter.read(
    context,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好了' }] },
    't2',
  );
  CodexLineWriter.read(context, { type: 'message', role: 'user', content: '' }, 't3');
  CodexLineWriter.read(
    context,
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '先读文件' }] },
    't4',
  );
  CodexLineWriter.read(
    context,
    { type: 'function_call', name: 'write_file', arguments: '{"path":"src/z.ts"}', call_id: 'c1' },
    't5',
  );
  CodexLineWriter.read(
    context,
    { type: 'function_call_output', call_id: 'c1', output: 'ok', success: true },
    't6',
  );
  CodexLineWriter.read(
    context,
    { type: 'function_call_output', call_id: 'c1', output: 'boom', success: false },
    't7',
  );
  CodexLineWriter.read(
    context,
    { type: 'function_call_output', call_id: 'c1', output: 'later' },
    't8',
  );
  CodexLineWriter.read(
    context,
    {
      type: 'local_shell_call',
      call_id: 'c2',
      action: { command: ['ls', '-la'] },
      status: 'completed',
    },
    't9',
  );
  CodexLineWriter.read(
    context,
    { type: 'local_shell_call', call_id: 'c3', action: { command: ['oops'] }, status: 'failed' },
    't10',
  );
  CodexLineWriter.read(
    context,
    {
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: src/c.ts\n*** End Patch',
      call_id: 'c4',
    },
    't11',
  );
  CodexLineWriter.read(context, { type: 'future_item', note: 'x' }, 't12');

  const kinds = context.records.map((record) => record.kind);
  assert.deepStrictEqual(kinds, [
    'user',
    'assistant',
    'reasoning',
    'tool_call',
    'tool_result',
    'tool_result',
    'tool_result',
    'tool_call',
    'tool_call',
    'tool_call',
    'other',
  ]);
  // message：块数组取 text；空内容不产记录（t3 无记录 ⇒ 上面共 11 条）。
  assert.strictEqual(context.records[0]?.text, '加个函数');
  assert.strictEqual(context.records[1]?.title, '助手回复');
  // function_call：JSON 字符串 arguments 被解析，写类工具的 path 进文件表，call_id 入 seenCalls。
  assert.strictEqual(context.records[3]?.title, 'write_file');
  assert.deepStrictEqual(context.records[3]?.files, ['src/z.ts']);
  assert.strictEqual(context.records[3]?.callId, 'c1');
  assert.ok(context.seenCalls.has('c1'));
  // function_call_output：success 三态 → ok / error / pending。
  assert.strictEqual(context.records[4]?.status, 'ok');
  assert.strictEqual(context.records[5]?.title, '工具失败');
  assert.strictEqual(context.records[6]?.status, 'pending');
  // local_shell_call：command join 成正文；completed/failed → ok/error。
  assert.strictEqual(context.records[7]?.text, 'ls -la');
  assert.strictEqual(context.records[7]?.status, 'ok');
  assert.strictEqual(context.records[8]?.status, 'error');
  // custom_tool_call：apply_patch 的 patch 头进文件表。
  assert.deepStrictEqual(context.records[9]?.files, ['src/c.ts']);
  assert.ok(context.seenCalls.has('c4'));
  // 未知 type：kind other，title = 原始 type。
  assert.strictEqual(context.records[10]?.kind, 'other');
  assert.strictEqual(context.records[10]?.title, 'future_item');
});

test('② event_msg 文本副本：有 response_item 消息时跳过（去重），没有时回退', () => {
  const withDedup = ctx(true);
  CodexLineWriter.readEvent(withDedup, { type: 'user_message', message: '加个函数' }, 't1');
  CodexLineWriter.readEvent(withDedup, { type: 'agent_message', message: '好了' }, 't2');
  CodexLineWriter.readEvent(withDedup, { type: 'agent_reasoning', text: '先读文件' }, 't3');
  assert.deepStrictEqual(withDedup.records, [], 'hasResponseMessages ⇒ 文本副本全跳过');

  const fallback = ctx(false);
  CodexLineWriter.readEvent(fallback, { type: 'user_message', message: '加个函数' }, 't1');
  CodexLineWriter.readEvent(fallback, { type: 'agent_message', message: '好了' }, 't2');
  CodexLineWriter.readEvent(fallback, { type: 'agent_reasoning', text: '先读文件' }, 't3');
  assert.deepStrictEqual(
    fallback.records.map((record) => record.kind),
    ['user', 'assistant', 'reasoning'],
  );
});

test('③ token_count：累计值取最后一次；缺 info.total_token_usage 不置位', () => {
  const context = ctx();
  CodexLineWriter.readEvent(
    context,
    {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 2,
          total_tokens: 17,
        },
      },
    },
    null,
  );
  CodexLineWriter.readEvent(
    context,
    {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 20,
          total_tokens: 170,
        },
      },
    },
    null,
  );
  assert.deepStrictEqual(context.tokens, {
    prompt: 100,
    completion: 50,
    cached: 20,
    total: 170,
    sawUsage: true,
  });
  const empty = ctx();
  CodexLineWriter.readEvent(empty, { type: 'token_count' }, null);
  assert.strictEqual(empty.tokens.sawUsage, false);
});

test('④ exec begin/end：response_item 出现过的 call_id 旁路；未出现过的记记录（exit_code 三态）', () => {
  const seen = ctx();
  seen.seenCalls.add('c1');
  CodexLineWriter.readEvent(
    seen,
    { type: 'exec_command_begin', call_id: 'c1', command: ['ls'] },
    't1',
  );
  CodexLineWriter.readEvent(
    seen,
    { type: 'exec_command_end', call_id: 'c1', exit_code: 0, stdout: 'done' },
    't2',
  );
  assert.deepStrictEqual(seen.records, [], 'response_item 已记录的调用不得重复');

  const fresh = ctx();
  CodexLineWriter.readEvent(
    fresh,
    { type: 'exec_command_begin', call_id: 'c9', command: ['ls', '-la'] },
    't1',
  );
  CodexLineWriter.readEvent(
    fresh,
    { type: 'exec_command_end', call_id: 'c9', exit_code: 0, stdout: 'done' },
    't2',
  );
  CodexLineWriter.readEvent(
    fresh,
    { type: 'exec_command_end', exit_code: 3, stderr: 'boom' },
    't3',
  );
  CodexLineWriter.readEvent(fresh, { type: 'exec_command_end' }, 't4');
  assert.strictEqual(fresh.records[0]?.kind, 'tool_call');
  assert.strictEqual(fresh.records[0]?.text, 'ls -la');
  assert.strictEqual(fresh.records[1]?.status, 'ok');
  assert.strictEqual(fresh.records[2]?.status, 'error');
  assert.strictEqual(fresh.records[3]?.status, 'pending');
});
