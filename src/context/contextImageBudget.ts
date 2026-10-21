import type { ModelMessage } from '../ports/model/model.ts';

/**
 * 图片附件预算（2026-10-19 引入，2026-10-21 从 `ContextAssembler` 拆出并改为按窗口自适应）。
 *
 * 工具附件会原样进入之后**每一次**请求：实测一个会话 7 张截图（合计 6.2 MiB base64）
 * 在 45 次模型调用里累计上传 82.4 MiB，且越到后面单次请求体越大。保留最近若干张即可；
 * 被省略的消息保留文件名，需要时用 `view_image` 重看。
 *
 * 这是纯函数式预算：不改事件日志（存档仍完整），只改发给模型的那一份投影。
 */
export class ContextImageBudget {
  /** 最近图片附件的保留预算（base64 字符数；内存/传输硬上限）。 */
  public static readonly IMAGE_ATTACHMENT_BUDGET_CHARS = 700_000;

  /**
   * 单张图片的保守 token 估算（与压缩器的 `IMAGE_TOKEN_ESTIMATE` 同口径）。
   *
   * provider 对 1200×700 截图的视觉编码约 1.4k token；取 1600 留余量。
   */
  public static readonly IMAGE_TOKEN_ESTIMATE = 1_600;

  /** 图片可占上下文窗口的份额（保守 25%）。 */
  public static readonly IMAGE_WINDOW_SHARE = 0.25;

  /** 缺省窗口（未注入时按 128k，保持旧行为量级）。 */
  private static readonly DEFAULT_WINDOW_TOKENS = 128_000;

  /**
   * 只保留最近的图片附件，较早的降级为一行文字说明。
   * @param messages 已组装的消息序列（原地替换过期附件）。
   * @param windowTokens 模型上下文窗口（可选；缺省 128k）。图片张数预算按窗口 25% 计算，
   *   避免小窗口仍塞两张截图、大窗口又过于保守。
   * @returns 无返回值。
   */
  public static retainRecent(messages: ModelMessage[], windowTokens?: number): void {
    const window =
      windowTokens !== undefined && windowTokens > 0
        ? windowTokens
        : ContextImageBudget.DEFAULT_WINDOW_TOKENS;
    // 张数预算：窗口 25% / 每张 1600 token，至少 1 张（最新一张永远保留）。
    const maxImages = Math.max(
      1,
      Math.floor(
        (window * ContextImageBudget.IMAGE_WINDOW_SHARE) / ContextImageBudget.IMAGE_TOKEN_ESTIMATE,
      ),
    );
    let kept = 0;
    let keptImages = 0;
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message === undefined) continue;
      const files = message.files ?? [];
      const images = message.images ?? [];
      if (files.length === 0 && images.length === 0) continue;
      const count = files.length + images.length;
      const bytes =
        files.reduce((sum, file) => sum + (file.data?.length ?? 0), 0) +
        images.reduce((sum, image) => sum + (image.data?.length ?? 0), 0);
      // 最新一份附件**无条件保留**：即便单张就超预算，也不能让模型看不到当前画面。
      if (
        seen === 0 ||
        (kept + bytes <= ContextImageBudget.IMAGE_ATTACHMENT_BUDGET_CHARS &&
          keptImages + count <= maxImages)
      ) {
        seen = 1;
        kept += bytes;
        keptImages += count;
        continue;
      }
      const names = files
        .map((file) => file.name)
        .filter((name) => name !== '')
        .join('、');
      const { files: _droppedFiles, images: _droppedImages, ...rest } = message;
      messages[i] = {
        ...rest,
        content:
          `${message.content}\n（较早的图片附件已省略以节省上下文` +
          `${names === '' ? '' : `：${names}`}；文件仍在工作区，需要时用 view_image 重新查看）`,
      };
    }
  }
}
