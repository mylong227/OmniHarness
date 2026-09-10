// diff 分块：把 patch 文本切成可供「块级 stage / 丢弃」的 hunk 片段。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

import { parseHunks } from '../textUtils.js';

/** 一个 hunk 片段（@@ 头 + 正文行）。 */
export interface HunkPart {
  header: string;
  lines: string[];
}

/** diff 分块器。 */
export class DiffHunkSplitter {
  /**
   * 切分：优先按真实 `@@` 分块；无 `@@` 的新文件（untracked，全是 + 行）合成单一 hunk，
   * 使「新文件」也能走块级 stage。既无 @@ 也无 + 行时返回空数组。
   */
  public static split(patch: string): HunkPart[] {
    const hunks = parseHunks(patch);
    if (hunks.length > 0) return hunks.map((h) => ({ header: h.header, lines: [...h.lines] }));
    const lines = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    if (lines.length === 0) return [];
    return [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }];
  }

  /** 还原成送给服务端 git apply 的 hunk 文本（@@ 头 + 正文）。 */
  public static text(h: HunkPart): string {
    return h.header + '\n' + h.lines.join('\n');
  }
}
