import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceIdentity } from '../../../util/workspaceIdentity.js';

/**
 * 会话**归入项目**的存档改写器（用户显式指认「未归属」会话的入口，2026-10-07 用户口径
 * 「各自分离不要出现串项目」的收尾）。
 *
 * 为什么单独成文件而不是塞进 `SessionArchive`：那个类已被编码标准门禁盯着（成员数/行数上限），
 * 而且"改写首行归属标记"这件事本身是**纯文件变换**，与归档的读取/索引职责不同。
 *
 * 契约（判据见 `tests/unit/sessionAssignWorkspace.test.ts`）：
 * ① 只改首行 `session_meta.payload.workspace`（写**归一值**），其余行**逐字不动**——存档是追加写的
 *    JSONL，历史事件一个字节都不该被这次归属变更碰到；
 * ② 整条没有 `session_meta` 的老存档补写一条（fail-safe：宁可补标记，也不让它继续"谁都不认"）；
 * ③ 目标为空 ⇒ 拒绝（fail-closed：绝不把归属写到一个空路径上），且不碰文件。
 */
export class SessionWorkspaceAssigner {
  /**
   * 把 `archiveDir/<sessionId>.jsonl` 的归属标记改写为目标项目。
   * @param archiveDir 会话存档目录
   * @param sessionId 会话 id
   * @param workspace 目标项目路径（调用方负责校验目录存在）
   * @returns `{ ok, workspace }`；目标为空或文件不存在（或被解析为坏 JSON 且无法补写）时 `{ ok:false, error }`
   */
  public static assign(
    archiveDir: string,
    sessionId: string,
    workspace: string,
  ): { ok: boolean; workspace?: string; error?: string } {
    const normalized = WorkspaceIdentity.normalize(workspace);
    if (normalized === '') return { ok: false, error: 'invalid_workspace' };
    const file = join(archiveDir, `${sessionId}.jsonl`);
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      return { ok: false, error: 'session_not_found' };
    }
    const lines = content.split('\n');
    let patched = false;
    for (let i = 0; i < lines.length && !patched; i += 1) {
      const line = lines[i];
      if (line === undefined || line === '' || !line.includes('session_meta')) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
        if (ev.type !== 'session_meta') continue;
        ev.payload = { ...(ev.payload ?? {}), workspace: normalized };
        lines[i] = JSON.stringify(ev);
        patched = true;
      } catch {
        /* 坏行跳过：不因一行解析失败放弃整条会话 */
      }
    }
    if (!patched) {
      lines.push(
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date().toISOString(),
          payload: { workspace: normalized },
        }),
      );
    }
    writeFileSync(file, lines.join('\n'), 'utf8');
    return { ok: true, workspace: normalized };
  }
}
