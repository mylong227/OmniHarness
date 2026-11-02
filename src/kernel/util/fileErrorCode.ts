/**
 * 从 `unknown` 错误里取 Node 错误码（`ENOENT` / `EPERM` …）。
 *
 * 存在理由：工具层要把「文件不存在」「被占用」翻译成对模型可行动的人话，而 `catch (error)`
 * 拿到的是 `unknown`。这段三元判断在多个文件里各写一份最容易漂移（`error instanceof Error`
 * 只对 Error 成立，Node 的 fs 错误通常是 Error，但 `code` 字段的类型仍是 any）。
 */
export class FileErrorCode {
  /**
   * 取错误码。
   * @param error 任意抛出值。
   * @returns `code` 字段；没有时 undefined。
   */
  public static of(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null
      ? (error as { code?: string }).code
      : undefined;
  }
}
