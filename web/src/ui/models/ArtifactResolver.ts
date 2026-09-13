// 产物解析：从工具调用（及其结果）里提取「可安全展示 / 预览 / 下载」的目标文件信息。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。
//
// 覆盖范围（D5：产物画廊 ≥5 工具）分三类：
//   - 产物本身：write_file（写文件）、apply_patch（打补丁）、sketch_write（草图，路径由工具回执给出）
//   - 文件引用：read_file（读取）、lsp_hover / lsp_go_to_definition / lsp_find_references（定位）
// 三者共用同一张卡片（统一「打开 / 下载」通路），避免每个工具各造一套展示。
//
// fail-closed 总则：路径缺失、形态不可判定（绝对路径 / 越界 `..` / 空串）一律返回 null——
// 宁可不展示卡片，也不展示一个点不开或指向工作区外的链接。

/** 产物类型：普通文件 / 补丁 / 草图。 */
export type ArtifactKind = 'file' | 'patch' | 'sketch';

/** 产物描述。 */
export interface ArtifactInfo {
  /** 展示用文件名。 */
  readonly name: string;
  /** 相对工作区的路径（URL 编码后给 /files?path=，并给 fs.read 预览）。 */
  readonly relPath: string;
  readonly kind: ArtifactKind;
}

/** 单类工具的产物规格。 */
interface ArtifactSpec {
  /** 卡片类型。 */
  readonly kind: ArtifactKind;
  /** 依序尝试的入参路径字段（首个非空者胜出）。 */
  readonly pathFields: readonly string[];
}

/**
 * 工具名 → 产物规格。
 *
 * 键为内置工具名（与 src/adapters/tool/** 的定义逐一对应）；未登记的工具一律不产卡片。
 * `sketch_write` 的路径由工具内部拼出（时间戳 + slug + 白名单扩展名，模型不传路径），
 * 故其 `pathFields` 为空——改由结果回执文本回读（见 `SKETCH_MARKER`）。
 */
const SPECS: Readonly<Record<string, ArtifactSpec>> = {
  write_file: { kind: 'file', pathFields: ['path'] },
  apply_patch: { kind: 'patch', pathFields: ['path'] },
  read_file: { kind: 'file', pathFields: ['path'] },
  lsp_hover: { kind: 'file', pathFields: ['file', 'path', 'target'] },
  lsp_go_to_definition: { kind: 'file', pathFields: ['file', 'path', 'target'] },
  lsp_find_references: { kind: 'file', pathFields: ['file', 'path', 'target'] },
  sketch_write: { kind: 'sketch', pathFields: [] },
};

/** 草图工具回执里「已保存」标记后跟的路径（`草图已保存: <rel>（...）`）。 */
const SKETCH_MARKER = /已保存[:：]\s*([^\s（(]+)/;

/** 需要回读结果文本的工具（其入参不含路径）。 */
const RESULT_DERIVED: ReadonlySet<string> = new Set(['sketch_write']);

/** 路径字段的兜底候选（工具规格未命中时按此顺序试）。 */
const FALLBACK_PATH_FIELDS: readonly string[] = ['path', 'file', 'file_path', 'target', 'filename'];

/** 产物解析器。 */
export class ArtifactResolver {
  /**
   * 解析一次工具调用对应的产物。
   *
   * @param name 工具名（与后端 ToolDefinition.name 一致）
   * @param args 工具入参（非对象一律视为不可解析）
   * @param resultText 工具结果文本（可选；仅草图等「路径由工具回执给出」的工具需要）
   * @returns 产物描述；不可安全解析时为 null（fail-closed）
   */
  public static fromTool(name: string, args: unknown, resultText?: string): ArtifactInfo | null {
    const spec = SPECS[name];
    if (!spec) return null;
    const rec = ArtifactResolver.asRecord(args);
    const fields = spec.pathFields.length > 0 ? spec.pathFields : FALLBACK_PATH_FIELDS;
    const raw = RESULT_DERIVED.has(name)
      ? ArtifactResolver.fromResult(resultText)
      : ArtifactResolver.pickPath(rec, fields);
    const relPath = ArtifactResolver.normalizeRel(raw);
    if (relPath === null) return null;
    return { name: ArtifactResolver.baseName(relPath), relPath, kind: spec.kind };
  }

  /**
   * 入参收敛为普通对象；非对象返回空对象（后续按缺字段处理）。
   * @param args 原始入参
   * @returns 记录对象
   */
  private static asRecord(args: unknown): Record<string, unknown> {
    return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  }

  /**
   * 依序取首个非空的字符串路径字段。
   * @param rec 入参记录
   * @param fields 候选字段名（按优先级）
   * @returns 命中的原始路径串；全空返回 ''
   */
  private static pickPath(rec: Record<string, unknown>, fields: readonly string[]): string {
    for (const key of fields) {
      const value = rec[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
  }

  /**
   * 从工具结果文本回读「已保存: <路径>」。
   * @param text 工具结果文本（可能为空）
   * @returns 回读到的路径；无匹配返回 ''
   */
  private static fromResult(text: string | undefined): string {
    if (typeof text !== 'string' || text === '') return '';
    const m = SKETCH_MARKER.exec(text);
    return m && m[1] ? m[1].trim() : '';
  }

  /**
   * 归一化相对路径并做安全校验（fail-closed）。
   *
   * 拒绝：空串 / 绝对路径（`/`、`\`、`X:`）/ 家目录（`~`）/ 含 `..` 段。
   * @param raw 原始路径串
   * @returns 归一化后的工作区相对路径；不合法返回 null
   */
  private static normalizeRel(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('~')) return null;
    if (/^[A-Za-z]:/.test(trimmed)) return null;
    const parts = trimmed.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
    if (parts.length === 0) return null;
    if (parts.includes('..')) return null;
    return parts.join('/');
  }

  /**
   * 取路径末段作为展示文件名。
   * @param relPath 已归一化的相对路径
   * @returns 文件名（无分隔符时即原串）
   */
  private static baseName(relPath: string): string {
    return relPath.split('/').pop() || relPath;
  }
}
