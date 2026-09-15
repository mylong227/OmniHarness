/**
 * 内容停用词表（ContentStopWords）——「代码语料上的高频功能词」常量命名空间。
 *
 * 用途：查询侧把自然语言疑问句降维成**内容词**（content terms），供
 *  - PRF 伪相关反馈（`contextEngine.query` 的扩展词筛选）与
 *  - 第二段重排（`FileRerankIndex.contentTerms`）共用。
 *
 * 单独成文件的理由：两处消费方分属不同模块（`contextEngine` 与 `fileRerankIndex`），
 * 若各自内联一份，口径必然漂移；放成叶子模块（不 import 任何本项目模块）既能共用、
 * 又不会给 `contextEngine ↔ fileReranker` 造成循环依赖。
 *
 * 判据口径：只收**语法功能词**（冠词/介词/代词/助动词/连词/常见疑问词）与
 * 代码关键字（`const` / `function` / `return` …）。**不收**领域实词——被误收的实词
 * 会让该词的 IDF 权重归零，直接抹掉一条召回线索（宁可漏收，不可错收）。
 *
 * 纯常量、零依赖、无状态；`static` 用法属标准允许的「常量命名空间」。
 */
export class ContentStopWords {
  /**
   * 停用词集合。以空格分隔的单表维护，避免手写数组时的重复与错漏。
   * 说明：`t` / `s` 等单字符词在实际使用处还会被「长度 < 3」规则再过滤一次，
   * 此处保留是为了让表本身语义完整（`has` 用于任意长度的词）。
   */
  private static readonly SET: ReadonlySet<string> = new Set(
    (
      'the and for this that with from import export const let var function return type interface ' +
      'class public private protected static async await if else new void string number boolean ' +
      'true false null undefined get set self in of to a an is are be as do it not use can will ' +
      'has have was were t s which what where how does when into out over on at by or more most ' +
      'many some one two first then than there their its them they you your we our'
    ).split(' '),
  );

  /**
   * 判断一个词是否为内容停用词。
   * @param term 待判定词项（调用方通常已小写化）
   * @returns 命中停用词表返回 true
   */
  public static has(term: string): boolean {
    return ContentStopWords.SET.has(term);
  }

  /**
   * 面向「重排/PRF 的内容词」判定：停用词或过短（< 3 字符）都不算内容词。
   * 把两条规则收在一处，避免各消费方各写一个长度阈值而漂移。
   * @param term 待判定词项（调用方通常已小写化）
   * @returns 是内容词返回 true
   */
  public static isContent(term: string): boolean {
    return term.length >= 3 && !ContentStopWords.SET.has(term);
  }
}
