// 长内容收起判定与预览裁剪（纯逻辑，零 React / DOM 依赖，node 环境可直测）。
//
// 背景（2026-10-13 用户反馈）：目录分析报告、压缩摘要这类数千字回复在对话流里**整段平铺**，
// 一屏全被占满，关键结论反而被淹没。正确形态是对齐「文档附件」的心智：默认只给一张
// 简报卡（标题 + 字数 + 前几行预览），点击再展开全文。
//
// 判定与裁剪收在模型层的原因：阈值是可独立判据的产品决策（多长算长、预览给多少），
// 组件只消费结论——判定写错时单测直接红，不必拉起组件测试。
import { t } from '../i18n/i18n.ts';

/**
 * 长内容收起判定器：判断一段正文是否应默认收起，并产出简报卡所需的摘要信息。
 */
export class LongContentCollapser {
  /** 字符数阈值：超过即视为长内容（对标单章 2000+ 字的常规长回复，报告类动辄数千字）。 */
  public static readonly COLLAPSE_CHARS = 2600;
  /** 行数阈值：短行多的清单类内容（代码/表格）按行兜底。 */
  public static readonly COLLAPSE_LINES = 48;
  /** 预览最多保留的行数。 */
  public static readonly PREVIEW_LINES = 14;
  /** 预览最多保留的字符数（防止超长单行把预览撑回「平铺」）。 */
  public static readonly PREVIEW_CHARS = 700;

  /**
   * 是否应默认收起：字符数或行数任一超限即为长内容。
   * @param text 正文（undefined/空串安全）
   * @returns 应收起则 true
   */
  public static shouldCollapse(text: string): boolean {
    if (!text) return false;
    if (text.length > this.COLLAPSE_CHARS) return true;
    return this.countLines(text) > this.COLLAPSE_LINES;
  }

  /**
   * 产出简报卡摘要：标题（取首个非空行，剥掉 markdown 修饰）、预览（截前几行/几字）、
   * 字数统计。预览与标题都从原文裁剪，不做任何改写（「简明扼要」靠取舍实现，不靠生成）。
   * @param text 正文
   * @returns 摘要信息
   */
  public static digest(text: string): {
    long: boolean;
    chars: number;
    lines: number;
    title: string;
    preview: string;
    truncated: boolean;
  } {
    const chars = text ? text.length : 0;
    const lines = text ? this.countLines(text) : 0;
    const long = this.shouldCollapse(text);
    return {
      long,
      chars,
      lines,
      title: this.titleOf(text),
      preview: this.previewOf(text),
      // truncated = 预览确实裁掉了内容（预览 == 全文时不能显示「展开」，那是撒谎）。
      truncated: long,
    };
  }

  /**
   * 统计行数（\n 分段；末尾无换行也算一行）。
   * @param text 正文
   * @returns 行数
   */
  private static countLines(text: string): number {
    let n = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) n++;
    }
    return n;
  }

  /**
   * 提取简报标题：首个非空行，剥掉行首 markdown 修饰（#/引用/列表/加粗斜体/行内码），
   * 超长截断加省略号。取不到（空内容）回退占位文案。
   * @param text 正文
   * @returns 标题（≤32 字符）
   */
  private static titleOf(text: string): string {
    const fallback = t('长文内容');
    if (!text) return fallback;
    for (const raw of text.split('\n')) {
      const line = raw
        .replace(/^\s{0,3}#{1,6}\s+/, '') // 标题
        .replace(/^\s*>\s?/, '') // 引用
        .replace(/^\s*[-*+]\s+/, '') // 无序列表
        .replace(/^\s*\d+[.)]\s+/, '') // 有序列表
        .replace(/[*_`~]/g, '') // 加粗/斜体/行内码
        .trim();
      if (line === '') continue;
      return line.length > 32 ? line.slice(0, 32) + '…' : line;
    }
    return fallback;
  }

  /**
   * 裁剪预览：先按行截（PREVIEW_LINES），再按字符截（PREVIEW_CHARS）双保险。
   *
   * 2026-10-20 修正：**优先在空行（块边界）收口**。此前直接切 14 行，会把一张表格
   * 切在表头/分隔行附近——预览里只剩表头，看起来像“一大块空白”（用户实测）。
   * 退到最近空行后，表格 / 围栏代码要么整块不出现，要么完整出现。
   * 只做裁剪，不补省略号——省略号由展示层用渐隐掩码表达（视觉信号比假文本诚实）。
   * @param text 正文
   * @returns 预览文本（始终是原文前缀）
   */
  private static previewOf(text: string): string {
    if (!text) return '';
    const lines = text.split('\n');
    let end = Math.min(lines.length, this.PREVIEW_LINES);
    // 从截断点向前找最近的空行：块边界收口，避免表格 / 围栏被切半。
    for (let i = end - 1; i >= 1; i--) {
      if ((lines[i] ?? '').trim() === '') {
        end = i;
        break;
      }
    }
    let preview = lines.slice(0, end).join('\n');
    if (preview.length > this.PREVIEW_CHARS) preview = preview.slice(0, this.PREVIEW_CHARS);
    return preview;
  }
}
