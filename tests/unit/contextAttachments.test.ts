/**
 * 工具结果附件通道单测（P2-⑬）：附件必须以**一条独立 user 消息**出现在所有 tool 消息之后。
 *
 * 为什么单测这条：把附件插在 tool 消息之间会破坏 `assistant(tool_calls)` ↔ `tool` 的配对，
 * OpenAI 兼容端点会直接 HTTP 400 —— 这是本通道最容易写错、也最贵的一处。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextAssembler } from '../../src/context/contextAssembler.js';
import { eventFactory } from '../../src/core/eventFactory.js';
import type { FileAttachment } from '../../src/ports/model/model.js';

/** 一份图片附件。 */
const image: FileAttachment = { name: 'shot.png', mediaType: 'image/png', data: 'AAAA' };

test('单个工具结果带附件：tool 消息之后追加一条 user 消息', () => {
  const events = [
    eventFactory.toolCall('s1', 'c1', 'view_image', { path: 'shot.png' }),
    eventFactory.toolResult('s1', 'c1', true, '已读取图片', undefined, [image]),
  ];
  const messages = new ContextAssembler().build(events);
  assert.deepStrictEqual(
    messages.map((message) => message.role),
    ['assistant', 'tool', 'user'],
  );
  assert.strictEqual(messages[2]?.files?.[0]?.name, 'shot.png');
  assert.ok(messages[2]?.content.includes('shot.png'));
});

test('同回合多个 tool 结果：附件被合并到**末尾**，不插在 tool 消息之间', () => {
  const events = [
    eventFactory.toolCall('s1', 'c1', 'view_image', { path: 'a.png' }),
    eventFactory.toolCall('s1', 'c2', 'read_file', { path: 'b.ts' }),
    eventFactory.toolResult('s1', 'c1', true, '图 A', undefined, [image]),
    eventFactory.toolResult('s1', 'c2', true, '文件 B'),
  ];
  const messages = new ContextAssembler().build(events);
  const roles = messages.map((message) => message.role);
  assert.deepStrictEqual(roles, ['assistant', 'tool', 'tool', 'user']);
  assert.strictEqual(messages[3]?.files?.length, 1);
  // 关键：两条 tool 消息必须相邻（中间不得夹 user）
  assert.strictEqual(messages[1]?.role, 'tool');
  assert.strictEqual(messages[2]?.role, 'tool');
});

test('同回合多张图：合并为一条 user 消息（不产生多条）', () => {
  const second: FileAttachment = { name: 'b.png', mediaType: 'image/png', data: 'BBBB' };
  const events = [
    eventFactory.toolCall('s1', 'c1', 'view_image', { path: 'a.png' }),
    eventFactory.toolCall('s1', 'c2', 'view_image', { path: 'b.png' }),
    eventFactory.toolResult('s1', 'c1', true, '图 A', undefined, [image]),
    eventFactory.toolResult('s1', 'c2', true, '图 B', undefined, [second]),
  ];
  const messages = new ContextAssembler().build(events);
  const users = messages.filter((message) => message.role === 'user');
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0]?.files?.length, 2);
});

test('无附件时不产生多余消息', () => {
  const events = [
    eventFactory.toolCall('s1', 'c1', 'read_file', { path: 'b.ts' }),
    eventFactory.toolResult('s1', 'c1', true, '文件 B'),
  ];
  const messages = new ContextAssembler().build(events);
  assert.deepStrictEqual(
    messages.map((message) => message.role),
    ['assistant', 'tool'],
  );
});

test('同一实例重复 build 不累积（每次投影都是全量重算）', () => {
  const assembler = new ContextAssembler();
  const events = [
    eventFactory.toolCall('s1', 'c1', 'view_image', { path: 'a.png' }),
    eventFactory.toolResult('s1', 'c1', true, '图 A', undefined, [image]),
  ];
  const first = assembler.build(events);
  const second = assembler.build(events);
  assert.strictEqual(first.length, second.length);
  assert.strictEqual(second.filter((message) => message.role === 'user').length, 1);
});
