/**
 * 会话「归入项目」判据（2026-10-07 用户口径：「各自分离不要出现串项目」的收尾——给未归属会话一个
 * 显式指认入口）。
 *
 * 判据钉三件事：
 * ① 只改首行 `session_meta.payload.workspace`（写归一值），**历史事件逐字不动**（存档是追加写 JSONL）；
 * ② 整条没有 `session_meta` 的老存档补写一条（fail-safe：不让它继续"谁都不认"）；
 * ③ 目标为空 / 运行中的会话拒绝改动（fail-closed：不把归属写到一个空路径上，也不动活动事件流）。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWorkspaceAssigner } from '../../src/server/services/session/sessionWorkspaceAssigner.js';

const dirs: string[] = [];

/**
 * 造一个临时会话存档目录并写入一条会话文件。
 * @param id 会话 id
 * @param lines 存档各行（JSON 字符串）
 * @returns 存档目录
 */
function seed(id: string, lines: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'omni-assign-'));
  dirs.push(root);
  writeFileSync(join(root, `${id}.jsonl`), lines.join('\n'), 'utf8');
  return root;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('会话归入项目：只改归属标记，历史逐字不动', () => {
  it('首行 session_meta 的 workspace 被改写为归一值，其余行字节级不变', () => {
    const meta = JSON.stringify({
      id: 'evt_1',
      type: 'session_meta',
      timestamp: '2026-10-07T00:00:00.000Z',
      payload: { workspace: 'D:/old/project' },
    });
    const user = JSON.stringify({
      id: 'evt_2',
      type: 'user',
      timestamp: '2026-10-07T00:00:01.000Z',
      payload: { content: '你好' },
    });
    const assistant = JSON.stringify({
      id: 'evt_3',
      type: 'assistant',
      timestamp: '2026-10-07T00:00:02.000Z',
      payload: { content: '在' },
    });
    const dir = seed('sess_assign_1', [meta, user, assistant]);
    const res = SessionWorkspaceAssigner.assign(dir, 'sess_assign_1', 'd:\\new\\project\\');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.workspace, 'D:\\new\\project', '必须落归一值（去尾分隔符 + 盘符大写）');
    const after = readFileSync(join(dir, 'sess_assign_1.jsonl'), 'utf8').split('\n');
    assert.strictEqual(after[1], user, '用户事件必须逐字不变');
    assert.strictEqual(after[2], assistant, '助手事件必须逐字不变');
    const patched = JSON.parse(after[0]!) as { type: string; payload: { workspace: string } };
    assert.strictEqual(patched.type, 'session_meta');
    assert.strictEqual(patched.payload.workspace, 'D:\\new\\project');
  });

  it('没有 session_meta 的老存档：补写一条标记（不让它继续"谁都不认"）', () => {
    const user = JSON.stringify({
      id: 'evt_9',
      type: 'user',
      timestamp: 't',
      payload: { content: 'hi' },
    });
    const dir = seed('sess_assign_2', [user]);
    const res = SessionWorkspaceAssigner.assign(dir, 'sess_assign_2', 'D:\\proj');
    assert.strictEqual(res.ok, true);
    const lines = readFileSync(join(dir, 'sess_assign_2.jsonl'), 'utf8').split('\n');
    assert.strictEqual(lines.length, 2, '原事件 + 追加的标记');
    assert.strictEqual(lines[0], user, '原事件不动');
    const meta = JSON.parse(lines[1]!) as { type: string; payload: { workspace: string } };
    assert.strictEqual(meta.type, 'session_meta');
    assert.strictEqual(meta.payload.workspace, 'D:\\proj');
  });

  it('目标为空 / 会话不存在 ⇒ fail-closed 拒绝（不写任何东西）', () => {
    const user = JSON.stringify({
      id: 'evt_9',
      type: 'user',
      timestamp: 't',
      payload: { content: 'hi' },
    });
    const dir = seed('sess_assign_3', [user]);
    assert.deepStrictEqual(SessionWorkspaceAssigner.assign(dir, 'sess_assign_3', '   '), {
      ok: false,
      error: 'invalid_workspace',
    });
    assert.deepStrictEqual(SessionWorkspaceAssigner.assign(dir, 'sess_missing', 'D:\\proj'), {
      ok: false,
      error: 'session_not_found',
    });
    assert.strictEqual(
      readFileSync(join(dir, 'sess_assign_3.jsonl'), 'utf8'),
      user,
      '拒绝时不得改写文件',
    );
  });
});
