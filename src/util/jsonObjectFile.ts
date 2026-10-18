import { existsSync, readFileSync } from 'node:fs';

/**
 * 读取「JSON 对象」形态的小型状态文件。
 *
 * 这两个存储（配额 / 会话模式）的契约相同：文件缺失、不可读、JSON 损坏、顶层不是对象
 * 一律视为「没有配置」，回退空对象；写入侧各自负责原子替换。把读取口径收在一处，
 * 避免两个存储对「数组算不算对象」「null 怎么办」各写一套而漂移。
 *
 * 为什么仍然吞掉解析错误：这是**读路径**，调用方会在下一次写入时覆盖坏文件；
 * 在此抛错只会让面板打不开。失败不静默的职责由写入路径与各自的判据承担。
 */
export class JsonObjectFile {
  /**
   * 读取一个 JSON 对象文件；任何异常形态都回退空对象。
   * @param file 绝对路径
   * @returns 顶层对象（非对象 / 数组 / 解析失败时为 `{}`）
   */
  public static readRecord(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
