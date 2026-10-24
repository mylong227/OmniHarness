// 回合变更文件清单（纯模型，借鉴同类成熟实现「Edited N files」卡片的数据面）。
//
// 职责单一：把服务端 turn_diff 事件的整回合 unified diff 文本
// （由 `UnifiedDiff.renderUnifiedDiff` 按文件渲染、`\n` 直连拼接）拆解为
// 「每文件：路径 + 增删行数 + 自身 diff 正文」，供 UI 渲染文件级清单。
//
// 纯函数、无 React、无 IO：同输入恒同输出，可脱离组件单测（web/test/turnDiffFiles.test.mjs）。

/** 回合内单个被修改文件的解析结果。 */
export interface TurnDiffFile {
  /** 文件相对路径（取自 `--- a/<path>` 头）。 */
  readonly path: string;
  /** 新增行数（`+` 行，不含 `+++` 头）。 */
  readonly added: number;
  /** 删除行数（`-` 行，不含 `---` 头）。 */
  readonly deleted: number;
  /** 该文件的 unified diff 正文（含 `---`/`+++`/`@@` 头，可直接喂 diff 渲染器）。 */
  readonly text: string;
  /**
   * 是否为本回合**新建**的文件（写入前不存在）。
   *
   * 判据：任一 hunk 头的旧侧行数为 0（`@@ -1,0 +1,N @@` / `@@ -0,0 +1,N @@`）——
   * TurnDiffTracker 对新建文件取的 before 快照是空串，UnifiedDiff 因此只能产出
   * beforeCount=0 的 hunk。改写已有文件即使整段替换，旧侧行数也不会是 0。
   */
  readonly created: boolean;
}

/** 全回合增删合计。 */
export interface TurnDiffTotals {
  readonly added: number;
  readonly deleted: number;
}

/**
 * 解析整回合 unified diff 为按文件的清单。
 *
 * 切分依据：`--- a/<path>` 行只可能是文件头——hunk 内的行都带前缀
 * （上下文 `' '`、删除 `'-'`、新增 `'+'`），删除行若原文以 `--- a/` 开头会渲染成
 * `---- a/…`，不匹配 `^--- a/`，故切分无歧义。
 * @param diff 整回合 unified diff 文本（turn_diff 事件的 payload.diff）。
 * @returns 按出现顺序的文件清单；空串/无文件段时为空数组。
 */
export function parseTurnDiffFiles(diff: string): readonly TurnDiffFile[] {
  const lines = (diff ?? '').replace(/\r\n/g, '\n').split('\n');
  const files: TurnDiffFile[] = [];
  let current:
    | { path: string; added: number; deleted: number; created: boolean; body: string[] }
    | undefined;

  const flush = (): void => {
    if (current !== undefined) {
      files.push({
        path: current.path,
        added: current.added,
        deleted: current.deleted,
        text: current.body.join('\n'),
        created: current.created,
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      flush();
      current = {
        path: line.slice('--- a/'.length),
        added: 0,
        deleted: 0,
        created: false,
        body: [line],
      };
      continue;
    }
    if (current === undefined) {
      continue; // 文件头之前的杂散行（空行等）——不构成文件段，忽略。
    }
    current.body.push(line);
    if (line.startsWith('@@')) {
      // hunk 头 `@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@`：旧侧行数为 0 ⇒ 新建文件。
      const m = /^@@ -\d+(?:,(\d+))? \+/.exec(line);
      if (m !== null && Number(m[1] ?? '1') === 0) current.created = true;
      continue;
    }
    if (line.startsWith('+++')) {
      continue; // 文件头，不计增删。
    }
    if (line.startsWith('+')) {
      current.added += 1;
    } else if (line.startsWith('-')) {
      current.deleted += 1;
    }
  }
  flush();
  return files;
}

/**
 * 汇总整回合增删行数。
 * @param files 按文件的解析清单。
 * @returns 增删合计。
 */
export function turnDiffTotals(files: readonly TurnDiffFile[]): TurnDiffTotals {
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    added += f.added;
    deleted += f.deleted;
  }
  return { added, deleted };
}
