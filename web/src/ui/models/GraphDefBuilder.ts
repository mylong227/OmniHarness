// DAG 图定义构建与节点状态映射：把编辑器的草稿行折算成服务端可接受的图定义。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 编辑器中的一步草稿。 */
export interface StepDraft {
  id: string;
  dep: string;
  prompt: string;
}

/** 图定义中的一步（提交给服务端的结构）。 */
export interface GraphStepDef {
  id: string;
  prompt: string;
  dependsOn?: string[];
}

/** 图定义。 */
export interface GraphDef {
  name: string;
  steps: GraphStepDef[];
  maxConcurrency: number;
}

/** 并发上限（与服务端默认一致）。 */
const MAX_CONCURRENCY = 4;

/** 图定义构建器。 */
export class GraphDefBuilder {
  /** 从草稿行构建定义：丢弃 id 或 prompt 为空的行；依赖按逗号切分并去空白。 */
  static build(name: string, steps: readonly StepDraft[]): GraphDef {
    const cleaned: GraphStepDef[] = steps
      .filter((s) => s.id.trim() !== '' && s.prompt.trim() !== '')
      .map((s) => {
        const def: GraphStepDef = { id: s.id.trim(), prompt: s.prompt };
        const deps = s.dep
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== '');
        if (deps.length > 0) def.dependsOn = deps;
        return def;
      });
    return { name: name.trim(), steps: cleaned, maxConcurrency: MAX_CONCURRENCY };
  }

  /** 把服务端返回的 dependsOn 数组还原成编辑器的逗号串。 */
  static depText(dependsOn: readonly string[] | undefined): string {
    return (dependsOn || []).join(',');
  }

  /** 节点状态 → CSS 类名；未知状态一律 pending（fail-closed 到最保守展示）。 */
  static statusClass(status: string): string {
    if (status === 'running') return 'running';
    if (status === 'done') return 'done';
    if (status === 'failed') return 'failed';
    if (status === 'skipped') return 'skipped';
    return 'pending';
  }
}
