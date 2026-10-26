/**
 * 读租约契约与实现（从 `WorkspaceFileCoordinator` 拆出：协调器本身已接近「上帝类」阈值，
 * 租约只是**持有的能力**，不是协调职责）。
 */
export interface FileReadLease {
  /** 绝对路径。 */
  readonly absolutePath: string;
  /**
   * 读取完整内容（同一路径的并发读共享一次盘 IO）。
   * @param maxBytes 最大字节数（超出抛错）。
   * @returns UTF-8 文本。
   */
  readText(maxBytes?: number): Promise<string>;
}

/** 读租约实现（读锁持有期间可用）。 */
export class FileReadLeaseHandle implements FileReadLease {
  /** 绝对路径。 */
  public readonly absolutePath: string;
  /** 真正的读取入口（由协调器注入；避免租约反向依赖协调器类型）。 */
  private readonly reader: (absolutePath: string, maxBytes?: number) => Promise<string>;

  /**
   * @param absolutePath 绝对路径。
   * @param reader 读取入口（通常绑定协调器的 `readText`）。
   */
  public constructor(
    absolutePath: string,
    reader: (absolutePath: string, maxBytes?: number) => Promise<string>,
  ) {
    this.absolutePath = absolutePath;
    this.reader = reader;
  }

  /**
   * 读取完整内容。
   * @param maxBytes 最大字节数（缺省由读取入口决定）。
   * @returns UTF-8 文本。
   */
  public readText(maxBytes?: number): Promise<string> {
    return this.reader(this.absolutePath, maxBytes);
  }
}
