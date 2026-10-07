// 会话隔离与工具卡状态判据（2026-10-07 用户两张截图）。
//
// 截图 1 标注：「非本会话的信息，却因为我切换会话就显示过来了」——切会话后，**另一个会话**正在跑的
// 工具卡（写入文件·进行中）出现在当前视图里。
// 截图 2 标注：「结果卡住了」——工具卡永远停在「进行中…」。
//
// 根因两条（都在 `SessionController`）：
// ① `handleEvent` 此前**不看事件的 sessionId**，SSE 推来的别家会话事件照单全收；
// ② 卡片状态只来自实时 `tool_result` 通知，而 `loadThread` 把 `toolResults` 清成 `{}` ⇒ 历史会话的
//    工具卡永远等不到结果（它的结果事件在 `items` 里躺着，却没人拿去重建状态）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'ui', 'controllers', 'SessionController.ts'), 'utf8');

test('接线守卫：事件流必须按 sessionId 过滤（别家会话的事件不得进本视图）', () => {
  assert.match(src, /ev as \{ sessionId\?: unknown \}\)\.sessionId/, '必须读事件自带的 sessionId');
  assert.match(
    src,
    /sid !== current\) \{[\s\S]{0,80}return;/,
    'sessionId 与当前会话不一致时必须直接丢弃（否则切会话会串进别家会话的工具卡）',
  );
  // 缺 sessionId 时不得丢事件（老服务端兼容）
  assert.match(src, /current !== null && current !== '' && sid !== current/, '两侧都有值才判定');
});

test('接线守卫：loadThread 必须从事件重建 toolResults（否则旧工具卡永远「进行中…」）', () => {
  assert.match(
    src,
    /const items = r\.items \|\| \[\];[\s\S]{0,900}results\[callId\] = this\.services\.reducers\.mergeToolResult/,
    '加载历史会话时必须把 tool_result 事件折叠回 toolResults',
  );
  assert.match(src, /toolResults: results,/, '重建结果必须真的写进状态（而不是只算不用）');
});
