/**
 * `sessions.list` 必须按**工作区**收敛（2026-10-06 第六十二轮真机 UI 跑测实测）。
 *
 * ## 它锁的是什么（现场形态）
 *
 * 会话存储目录是**全局**的（`~/.omniharness/sessions`）。真机跑测时，用一个**全新临时工作区**
 * 打开 Web UI，侧栏列出了 **1181 条**会话——全是其它项目的真实对话标题（含本轮模型跑测的
 * 「这个任务要并行推进…」等），而当前工作区其实一条会话都没有。既有误导性（看着像本项目历史），
 * 也让每次刷新白搬上千行。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 传了 workspace ⇒ **只**返回归属该工作区的会话（明确属于别的项目的一条都不许出现） |
 * | ② | **无归属标记**的历史会话（`session_meta` 缺失/无 workspace）必须保留——它们无法归因，隐藏等于让用户够不到旧数据 |
 * | ③ | 不传 workspace ⇒ 语义不变（不过滤）——`sessionExists`、`search.all` 等跨项目调用方不受影响 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionArchive } from '../../src/server/services/session/sessionArchive.js';

/** 本工作区路径。 */
const THIS_WS = process.platform === 'win32' ? 'C:\\tmp\\proj-this' : '/tmp/proj-this';
/** 另一个工作区路径。 */
const OTHER_WS = process.platform === 'win32' ? 'C:\\tmp\\proj-other' : '/tmp/proj-other';

/**
 * 写一个最小的会话存档（只含 `session_meta` + 一条 user 事件）。
 * @param dir 存储目录。
 * @param id 会话 id。
 * @param workspace 工作区标记（undefined = 无标记的历史会话）。
 * @param label 首条用户消息（决定侧栏标题）。
 * @returns 无返回值。
 */
function writeSession(dir: string, id: string, workspace: string | undefined, label: string): void {
  const lines = [
    JSON.stringify({
      id: `evt_${id}_1`,
      type: 'session_meta',
      sessionId: id,
      timestamp: '2026-10-06T00:00:00.000Z',
      payload: workspace === undefined ? {} : { workspace },
    }),
    JSON.stringify({
      id: `evt_${id}_2`,
      type: 'user',
      sessionId: id,
      timestamp: '2026-10-06T00:00:01.000Z',
      payload: { content: label },
    }),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

/**
 * 造一个只读的会话目录 fixture。
 * @returns 目录与已关闭用的清理函数。
 */
function fixture(): {
  dir: string;
  archive: SessionArchive;
  ids: (workspace?: string) => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sess-scope-'));
  writeSession(dir, 'sess_this_1', THIS_WS, '本项目会话');
  writeSession(dir, 'sess_other_1', OTHER_WS, '外部项目会话-不应出现在本项目');
  writeSession(dir, 'sess_legacy_1', undefined, '无归属历史会话');
  const archive = new SessionArchive({
    workspaceRoot: () => THIS_WS,
    storageLocation: () => dir,
    configuredStorageDir: () => undefined,
  });
  const ids = (workspace?: string): string[] => {
    const listed = archive.list(false, workspace) as { sessions: { sessionId: string }[] };
    return listed.sessions.map((s) => s.sessionId).sort();
  };
  return { dir, archive, ids };
}

test('① 传 workspace：只返回本工作区会话（明确属于别的项目的一条都不许出现）', () => {
  const { dir, ids } = fixture();
  try {
    const got = ids(THIS_WS);
    assert.deepStrictEqual(got, ['sess_legacy_1', 'sess_this_1']);
    assert.ok(!got.includes('sess_other_1'), '外部项目的会话漏进了本工作区列表');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② 无归属标记的历史会话必须保留（不能因为归不了因就藏起来）', () => {
  const { dir, ids } = fixture();
  try {
    assert.ok(ids(THIS_WS).includes('sess_legacy_1'));
    assert.ok(ids(OTHER_WS).includes('sess_legacy_1'), '换个工作区也该看得到无标记的历史会话');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 作用域语义：缺省 = 当前工作区；`*` = 不过滤（跨项目调用方用）', () => {
  const { dir, ids } = fixture();
  try {
    assert.deepStrictEqual(ids(), ['sess_legacy_1', 'sess_this_1'], '缺省必须收敛到当前工作区');
    assert.deepStrictEqual(
      ids('*'),
      ['sess_legacy_1', 'sess_other_1', 'sess_this_1'],
      '`*` 必须给出全量（sessionExists / search.all 依赖它看跨项目会话）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
