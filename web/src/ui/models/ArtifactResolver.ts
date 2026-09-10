// 产物解析：从写类工具的入参里提取「可安全展示 / 下载」的目标文件信息。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 产物描述。 */
export interface ArtifactInfo {
  /** 展示用文件名。 */
  readonly name: string;
  /** 相对工作区的路径（URL 编码后给 /files?path=）。 */
  readonly relPath: string;
  readonly kind: 'file' | 'patch';
}

/** 产物解析器。 */
export class ArtifactResolver {
  /**
   * 仅 write_file / apply_patch 视为产物型工具；路径缺失或非对象入参一律返回 null
   * （fail-closed：宁可不展示卡片，也不展示一个点不开的链接）。
   */
  public static fromTool(name: string, args: unknown): ArtifactInfo | null {
    if (!args || typeof args !== 'object') return null;
    const a = args as Record<string, unknown>;
    if (name !== 'write_file' && name !== 'apply_patch') return null;
    const path = typeof a['path'] === 'string' ? a['path'] : '';
    if (path === '') return null;
    const fileName = path.split(/[\\/]/).pop() || path;
    return { name: fileName, relPath: path, kind: name === 'apply_patch' ? 'patch' : 'file' };
  }
}
